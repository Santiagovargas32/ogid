#!/usr/bin/env python3
"""Read every original validation log; emit only allowlisted, redacted metadata.

Usage: python3 backend/scripts/agent-log-audit.py .agent-validation docs/audits/2026-10-20
No database access, mutations of originals, network or third-party dependencies.
"""
import collections
import datetime as dt
import hashlib
import json
import pathlib
import re
import sys
from urllib.parse import urlsplit, parse_qs

NAMES = [
    'shadow-backend-20261019-092503.log', 'shadow-backend-20261019-093603.log',
    'shadow-backend-20261019-102723.log', 'shadow-backend-20261019-115112.log',
    'shadow-backend-final-20261019.log', 'shadow-backend-read-isolation-20261019.log',
    'shadow-backend-recovery-20261019.log', 'shadow-backend-recovery-20261019-run2.log',
    'shadow-backend-recovery-20261019-run3.log', 'shadow-backend-verified-20261019.log',
]
LIFECYCLE = re.compile(r'server_started|server_stopped|startup_failed|shutdown_|worker_failed|worker_recovered|agent_component_')
IDENTIFIER = re.compile(r'^[A-Za-z0-9._:-]{1,256}$')

def stamp(value):
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, TypeError, ValueError):
        return None

def endpoint(value):
    return re.sub(r'/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|ses_[A-Za-z0-9_-]+)(?=/|$)', '/:id', urlsplit(value or '').path)

def projection(n, row):
    result = {'line': n}
    for key in ('timestamp', 'level', 'scope', 'message', 'code', 'causeCode', 'requestId',
                'jobId', 'sessionId', 'snapshotId', 'fence', 'component', 'threadId',
                'operation', 'service', 'method', 'statusCode', 'durationMs', 'exitCode',
                'signal', 'recoveries', 'cleanupErrors', 'connectionId', 'closeCode'):
        value = row.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            if key in row:
                result[key] = value if key != 'message' or isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,95}', value) else '[redacted]' 
    if row.get('path'):
        result['endpoint'] = endpoint(row['path'])
        for key in ('jobId', 'sessionId', 'snapshotId', 'evidenceId'):
            value = parse_qs(urlsplit(row['path']).query).get(key, [None])[0]
            if value and IDENTIFIER.fullmatch(value):
                result[key] = value
    command = row.get('command')
    if isinstance(command, dict):
        result['command'] = {k: command[k] for k in ('operation', 'service', 'method', 'kind', 'worker', 'phase', 'timeoutMs', 'executionMs', 'elapsedMs', 'queuedAt') if k in command}
    # Existing SQL logs already replace literals. Do not export SQL or stacks.
    if row.get('sql'):
        result['sqlSignatureSha256'] = hashlib.sha256(row['sql'].encode()).hexdigest()
    return result

def percentile(values, p):
    values = sorted(values)
    return values[min(len(values)-1, max(0, __import__('math').ceil(len(values)*p)-1))] if values else None

def analyse(file):
    raw = file.read_bytes()
    lines = raw.decode('utf-8', errors='replace').splitlines()
    rows = []
    for n, line in enumerate(lines, 1):
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append((n, row))
        except ValueError:
            pass
    timed = [(n, r, stamp(r.get('timestamp'))) for n, r in rows if stamp(r.get('timestamp')) is not None]
    start = next((t for _, r, t in timed if r.get('message') == 'server_started'), None)
    stop = next((t for _, r, t in timed if r.get('message') == 'shutdown_signal_received'), None)
    signatures = {}
    phases = collections.Counter()
    endpoints = collections.defaultdict(lambda: {'latencies': [], 'statuses': collections.Counter(), 'firstLine': None})
    ids = collections.defaultdict(list)
    providers = collections.defaultdict(list)
    gaps = []
    previous = None
    for i, (n, r) in enumerate(rows):
        time = stamp(r.get('timestamp'))
        phase = 'startup' if start is None or time is not None and time < start else 'shutdown' if stop is not None and time is not None and time >= stop else 'running'
        phases[phase] += 1
        if previous and time is not None and time - previous[2] > 30:
            gaps.append({'afterLine': previous[0], 'beforeLine': n, 'seconds': round(time-previous[2], 3)})
        if time is not None:
            previous = (n, r, time)
        projected = projection(n, r)
        for key in ('requestId', 'jobId', 'sessionId', 'snapshotId', 'connectionId'):
            if projected.get(key):
                ids[f'{key}:{projected[key]}'].append(n)
        if r.get('level') in ('warn', 'error'):
            cmd = r.get('command') if isinstance(r.get('command'), dict) else {}
            sig = tuple(str(x) for x in (r.get('scope'), r.get('message'), r.get('code'), cmd.get('operation') or r.get('operation'), cmd.get('service') or r.get('service'), cmd.get('method') or r.get('method'), projected.get('sqlSignatureSha256')))
            entry = signatures.setdefault(sig, {'signature': list(sig), 'count': 0, 'first': projected, 'lastLine': n, 'context': [projection(a, b) for a, b in rows[max(0, i-2):i+3]], 'phases': collections.Counter()})
            entry['count'] += 1
            entry['lastLine'] = n
            entry['phases'][phase] += 1
        if r.get('message') == 'http_request':
            entry = endpoints[f"{r.get('method')} {endpoint(r.get('path'))}"]
            entry['firstLine'] = entry['firstLine'] or n
            entry['statuses'][str(r.get('statusCode'))] += 1
            if isinstance(r.get('durationMs'), (int, float)):
                entry['latencies'].append(r['durationMs'])
        if r.get('message') == 'news_provider_request_start':
            providers[r.get('provider')].append(n)
        if r.get('message') in ('news_provider_summary', 'news_provider_failed') and providers[r.get('provider')]:
            providers[r.get('provider')].pop(0)
    http = []
    for name, entry in sorted(endpoints.items()):
        total = sum(entry['statuses'].values())
        failures = sum(v for k, v in entry['statuses'].items() if k.isdigit() and int(k) >= 500)
        http.append({'endpoint': name, 'requests': total, 'serverErrors': failures, 'serverErrorRate': failures/total, 'statuses': dict(entry['statuses']),
                     'latencySamples': len(entry['latencies']), 'p50Ms': percentile(entry['latencies'], .5), 'p95Ms': percentile(entry['latencies'], .95), 'p99Ms': percentile(entry['latencies'], .99), 'firstLine': entry['firstLine']})
    return {'file': file.name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'lines': len(lines), 'jsonRows': len(rows), 'nonJsonLines': len(lines)-len(rows),
            'firstAt': timed[0][1].get('timestamp') if timed else None, 'lastAt': timed[-1][1].get('timestamp') if timed else None,
            'observedSeconds': round(timed[-1][2]-timed[0][2], 3) if timed else None, 'head': 'not-recorded', 'configuration': 'not-fully-recorded',
            'phases': dict(phases), 'levels': dict(collections.Counter(r.get('level') for _, r in rows)),
            'lifecycle': [projection(n, r) for n, r in rows if LIFECYCLE.search(str(r.get('message', '')))],
            'websocket': [projection(n,r) for n,r in rows if r.get('message') in ('ws_client_connected','ws_client_disconnected')],
            'gapsOver30Seconds': gaps, 'signatures': sorted(signatures.values(), key=lambda e: -e['count']), 'http': http,
            'correlations': [{'id': key, 'lines': value} for key, value in sorted(ids.items()) if len(value)>1 or key.startswith('snapshotId:')],
            'unmatchedProviderStarts': dict(providers),
            'limits': ['HTTP records are completions, not start events. Missing completions cannot be inferred for every operation.', 'Log gaps do not prove process downtime.', 'Repeated code log records can describe one incident; HTTP denominators count completed requests only.', 'No job state chronology without durable rows or IDs in the original logs.']}

def main():
    source, output = map(pathlib.Path, sys.argv[1:3])
    output.mkdir(parents=True, exist_ok=True)
    reports = [analyse(source/name) for name in NAMES if (source/name).exists()]
    missing = [name for name in NAMES if not (source/name).exists()]
    related = []
    # Read ALL additional log/report/jsonl bytes, while exporting only hashes,
    # test totals, numeric report fields and allowlisted event metadata.
    for file in sorted(source.rglob('*')):
        if not file.is_file() or file.suffix not in ('.log', '.json', '.jsonl', '.md') or file.name in NAMES or 'audit-20261020' in file.parts:
            continue
        raw = file.read_bytes(); text = raw.decode('utf-8', errors='replace')
        summaries=[]
        decoder=json.JSONDecoder()
        for match in re.finditer(r'(?m)^\{',text):
            try:
                value,_=decoder.raw_decode(text[match.start():])
            except ValueError:
                continue
            if not isinstance(value,dict) or not any(k in value for k in ('checks','errorCode','completedObservation','snapshotMs','httpMs','requestedHours')):
                continue
            summary={k:value[k] for k in ('schemaVersion','kind','status','state','ready','errorCode','durationMs','elapsedMs','snapshotMs','recoveredAfterReopen','node','requestedHours','completedObservation','observedMs') if isinstance(value.get(k),(str,int,float,bool))}
            for key in ('httpMs','eventLoopDelayMs'):
                if isinstance(value.get(key),dict):summary[key]={k:v for k,v in value[key].items() if isinstance(v,(int,float))}
            if summary:summaries.append(summary)
        related.append({'file': str(file.relative_to(source)), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                        'lines': len(text.splitlines()), 'testTotals': re.findall(r'^# (?:tests|pass|fail|cancelled|skipped|duration_ms) [\d.]+$', text, re.M),
                        'reportSummaries':summaries[:20],
                        'events': [projection(n, r) for n, line in enumerate(text.splitlines(), 1) if (r := parse_line(line)) and r.get('level') == 'error'][:10]})
    (output/'logs.json').write_text(json.dumps({'missing': missing, 'runs': reports, 'related': related}, indent=2, ensure_ascii=False)+'\n')
    table = ['# Comparación de logs originales', '', 'Fechas UTC. Lectura completa por programa; extractos contextuales mediante lista de campos permitidos. Los originales no se modifican.', '',
             '| Ejecución | Ventana observada | Segundos | HTTP completados / 5xx | Warn / error | Cierre |', '|---|---|---:|---:|---:|---|']
    for r in sorted(reports, key=lambda r: r['firstAt'] or ''):
        total = sum(e['requests'] for e in r['http']); errors = sum(e['serverErrors'] for e in r['http'])
        closed = 'registrado' if any(e.get('message') == 'server_stopped' for e in r['lifecycle']) else 'no demostrado'
        table.append(f"| {r['file']} | {r['firstAt']} → {r['lastAt']} | {r['observedSeconds']} | {total} / {errors} ({errors/total:.2%}) | {r['levels'].get('warn', 0)} / {r['levels'].get('error', 0)} | {closed} |" if total else f"| {r['file']} | {r['firstAt']} → {r['lastAt']} | {r['observedSeconds']} | 0 | {r['levels'].get('warn', 0)} / {r['levels'].get('error', 0)} | {closed} |")
    table += ['', 'Los 5xx usan como denominador las peticiones HTTP completadas en cada archivo; no son tasas de disponibilidad por tiempo. Cada firma conserva primera aparición, contexto ±2 registros, frecuencia, última línea y fase en [logs.json](logs.json). Las latencias son por endpoint y ejecución.', '',
              f'Logs solicitados ausentes: {", ".join(missing) or "ninguno"}. Otros artefactos leídos: {len(related)}. No se encontró ningún JSON/JSONL original: las carpetas de observación y copias están vacías en este checkout.' if not any(p.suffix in ('.json','.jsonl') for p in source.rglob('*') if 'audit-20261020' not in p.parts) else f'Otros artefactos leídos: {len(related)}.', '',
              'No constan SHA ni configuración completa por ejecución: no se atribuyen automáticamente estos logs a HEAD. Los IDs correlacionables son principalmente requestId y snapshotId; faltan eventos durables para reconstruir todos los turnos. Los informes llamados final/verified no prueban estabilidad.', '']
    for r in sorted(reports, key=lambda r: r['firstAt'] or ''):
        table += [f"## {r['file']}", '', f"SHA-256 `{r['sha256']}`; {r['lines']} líneas, {r['jsonRows']} objetos JSON. Fases: `{r['phases']}`.", '']
        for e in r['lifecycle']:
            table.append(f"- Línea {e['line']}: {e.get('timestamp')} — {e.get('message')} {e.get('code') or e.get('component') or ''}")
        table += ['', f"Huecos >30 s: {len(r['gapsOver30Seconds'])}; mayor: {max((g['seconds'] for g in r['gapsOver30Seconds']), default=0)} s. Inicios de proveedor sin pareja al final: `{r['unmatchedProviderStarts']}` (heurística por proveedor; concurrencia no identificada).", '', 'Firmas principales:', '']
        for s in r['signatures'][:8]:
            f=s['first']; table.append(f"- `{f.get('message')}` / `{f.get('code')}`: {s['count']} registros; primera línea {f['line']}, última {s['lastLine']}.")
        table.append('')
    (output/'logs.md').write_text('\n'.join(table))
    print(json.dumps({'runs': len(reports), 'missing': missing, 'relatedFiles': len(related), 'output': str(output)}))

def parse_line(line):
    try:
        result = json.loads(line.lstrip('# '))
        return result if isinstance(result, dict) else None
    except ValueError:
        return None

if __name__ == '__main__':
    main()
