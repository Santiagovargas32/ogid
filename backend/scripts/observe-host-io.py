#!/usr/bin/env python3
"""Bounded Linux /proc observer, external to OGID. No writes to business storage.

Use a private tmpfs output directory. First sample is a baseline, never a rate.
Disk sectors are 512 bytes; select whole devices, not also their partitions.
Process counters include their threads; thread samples only describe waits.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import time


def read(path):
    try:
        return Path(path).read_text()[:65536]
    except OSError:
        return None


def counters(value):
    return {k: int(v.split()[0]) for line in (value or '').splitlines()
            if ':' in line for k, v in [line.split(':', 1)] if v.split() and v.split()[0].isdigit()}


def stat(value):
    # comm may contain spaces or parentheses. Field 22 is process starttime.
    end = value.rindex(')')
    fields = value[end + 2:].split()
    return dict(comm=value[value.index('(') + 1:end], state=fields[0],
                ppid=int(fields[1]), minflt=int(fields[7]), majflt=int(fields[9]),
                cpuTicks=int(fields[11]) + int(fields[12]), starttime=int(fields[19]),
                rssBytes=int(fields[21]) * os.sysconf('SC_PAGE_SIZE'))


def delta(current, previous):
    return {k: v - previous[k] for k, v in current.items()
            if isinstance(v, int) and k in previous and isinstance(previous[k], int)
            and v >= previous[k]}


def process_deltas(current, previous):
    if not previous or previous['starttime'] != current['starttime']:
        return {}
    return dict(delta=delta(current, previous), ioDelta=delta(current['io'], previous['io']))


def disk_rates(d, seconds):
    def await_ms(ms, count):
        return d[ms] / d[count] if d[count] else None
    return dict(readIOPS=d[0] / seconds, writeIOPS=d[4] / seconds,
                readBytesPerSecond=d[2] * 512 / seconds,
                writeBytesPerSecond=d[6] * 512 / seconds,
                readAwaitMs=await_ms(3, 0), writeAwaitMs=await_ms(7, 4),
                flushAwaitMs=await_ms(16, 15) if len(d) >= 17 else None,
                flushIOPS=d[15] / seconds if len(d) >= 17 else None,
                averageQueue=d[10] / (seconds * 1000),
                busyPercent=d[9] / (seconds * 10))


def archive(source, directory):
    """Copy after observation, exclusively; never overwrite prior evidence."""
    destination = Path(directory) / Path(source).name
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output, open(source, 'rb') as input_file:
        shutil.copyfileobj(input_file, output, 65536)
        output.flush()
        os.fsync(output.fileno())
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def sample(devices, previous, previous_processes):
    begin = time.monotonic()
    result = dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  monotonic=begin, clockTicksPerSecond=os.sysconf('SC_CLK_TCK'),
                  pageSizeBytes=os.sysconf('SC_PAGE_SIZE'),
                  bootId=(read('/proc/sys/kernel/random/boot_id') or '').strip() or None,
                  meminfoKiB=counters(read('/proc/meminfo')),
                  psi={k: read('/proc/pressure/' + k) for k in ('io', 'memory', 'cpu')},
                  vmstat={k: int(v) for line in (read('/proc/vmstat') or '').splitlines()
                          for k, v in [line.split()] if k.startswith((
                              'pgmajfault', 'pswp', 'pgscan', 'pgsteal', 'allocstall',
                              'workingset_refault', 'oom_kill'))},
                  zram={k: read('/sys/block/zram0/' + k) for k in ('mm_stat', 'bd_stat')},
                  disks={}, processes=[], blockedThreads=[], ioDenied=0)
    seconds = begin - previous['monotonic'] if previous else None
    for line in (read('/proc/diskstats') or '').splitlines():
        f = line.split()
        if f[2] not in devices:
            continue
        raw = list(map(int, f[3:]))
        value = dict(raw=raw, inFlight=raw[8])
        old = previous.get('disks', {}).get(f[2]) if previous else None
        if old and len(raw) == len(old['raw']):
            diff = [a - b for a, b in zip(raw, old['raw'])]
            # inFlight is a gauge, not a monotonic counter.
            if all(v >= 0 for i, v in enumerate(diff) if i != 8):
                value['interval'] = disk_rates(diff, seconds)
        result['disks'][f[2]] = value
    processes = {}
    for p in Path('/proc').glob('[0-9]*'):
        try:
            s = stat((p / 'stat').read_text())
            io = read(p / 'io')
            if io is None:
                result['ioDenied'] += 1
            s.update(pid=int(p.name), io=counters(io))
            old = previous_processes.get(s['pid'])
            s.update(process_deltas(s, old))
            processes[s['pid']] = s
            # No argv or environment is collected. Inspect relevant processes
            # and any process whose main thread is in uninterruptible wait.
            if s['comm'] in ('node', 'llama-server', 'code', 'codex', 'npm start') or s['state'] == 'D':
                s['wchan'] = read(p / 'wchan')
                s.update({k: v for k, v in counters(read(p / 'status')).items()
                          if k in ('VmRSS', 'VmSwap', 'RssAnon', 'RssFile', 'RssShmem')})
                blocked = []
                tasks = list((p / 'task').glob('[0-9]*'))
                for task in tasks[:256]:
                    ts = read(task / 'stat')
                    if ts and stat(ts)['state'] == 'D':
                        blocked.append(dict(pid=s['pid'], starttime=s['starttime'],
                                            tid=int(task.name), wchan=read(task / 'wchan')))
                result['blockedThreads'].extend(blocked[:64])
                if len(tasks) > 256:
                    s['threadsTruncated'] = True
        except (OSError, ValueError, IndexError):
            continue  # Process exited during a non-atomic /proc scan.
    chosen = {p['pid'] for p in processes.values()
              if p['comm'] in ('node', 'llama-server', 'code', 'codex', 'npm start') or p['state'] == 'D'}
    for score in (lambda p: p['rssBytes'],
                  lambda p: p.get('ioDelta', {}).get('read_bytes', 0),
                  lambda p: p.get('ioDelta', {}).get('write_bytes', 0),
                  lambda p: p.get('delta', {}).get('majflt', 0)):
        chosen.update(p['pid'] for p in sorted(processes.values(), key=score, reverse=True)[:8])
    result['processes'] = [processes[pid] for pid in sorted(chosen)[:96]]
    result['processesTruncated'] = len(chosen) > 96
    result['blockedThreadsTruncated'] = len(result['blockedThreads']) > 128
    result['blockedThreads'] = result['blockedThreads'][:128]
    memory = counters(read('/proc/self/status'))
    result['observer'] = dict(pid=os.getpid(), collectionMs=(time.monotonic() - begin) * 1000,
                              cpuSeconds=time.process_time(), rssKiB=memory.get('VmRSS'),
                              highWaterRssKiB=memory.get('VmHWM'))
    return result, processes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output')
    parser.add_argument('--duration', type=float, default=180)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--devices', nargs='+', default=['sda', 'sdb', 'zram0'])
    parser.add_argument('--archive-directory', help='existing private durable directory; copy only after capture')
    args = parser.parse_args()
    if not (1 <= args.interval <= 60 and 1 <= args.duration <= 3600):
        parser.error('interval 1..60 s, duration 1..3600 s')
    # Refuse to mix whole devices and partitions; do not sum stacked layers.
    for device in args.devices:
        if not device.isalnum() or Path('/sys/class/block', device, 'partition').exists():
            parser.error('select whole devices, not partitions')
    previous, processes = None, {}
    deadline = time.monotonic() + args.duration
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', buffering=1) as output:
            while True:
                current, processes = sample(set(args.devices), previous, processes)
                line = json.dumps(current, separators=(',', ':')) + '\n'
                if output.tell() + len(line.encode()) > 32 * 1024 * 1024:
                    raise RuntimeError('32 MiB output budget exceeded')
                output.write(line)
                previous = current
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(remaining, max(0, args.interval - current['observer']['collectionMs'] / 1000)))
    finally:
        if args.archive_directory:
            archive(args.output, args.archive_directory)


if __name__ == '__main__':
    main()
