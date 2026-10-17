const escape = value => String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const bytes = value => Number.isFinite(value) ? (value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(2)} MiB`) : "—";
const duration = value => Number.isFinite(value) ? (value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`) : "—";
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString("es-ES") : "—";
const states = {ready:"Listo",disabled:"Desactivado",new:"Sin iniciar",starting:"Iniciando",closing:"Cerrando",closed:"Cerrado",failed:"Falló"};
const phases = {executing:"En ejecución",dispatched:"Enviado al worker",queued:"En cola",completed:"Completada",failed:"Falló",rejected:"Rechazada"};
function operation(command) {
  const names = {"market.analyze":"Análisis de mercado","news.ingest":"Guardar noticias","news.getProjection":"Proyección de noticias","candles.upsert":"Guardar velas","candles.append":"Guardar velas"};
  const technical = [command.operation, command.service, command.method, command.kind].filter(Boolean).join(" / ");
  return `<strong>${escape(names[`${command.service}.${command.method}`] || command.kind || command.method || command.operation)}</strong><div class="small text-light-emphasis">${escape(technical)}</div>`;
}
function rows(commands, recent = false) {
  return commands.map(command => `<tr><td>${escape(command.workerLabel)}</td><td>${operation(command)}</td>
    <td>${escape(command.code === "STORAGE_OUTCOME_UNKNOWN" ? "Resultado incierto" : phases[recent ? command.status : command.phase] || command.phase)}${command.code ? `<div class="text-warning small">${escape(command.code)}</div>` : ""}</td>
    <td>${escape(bytes(command.bytes))}</td><td>${escape(duration(command.queueMs))}</td><td>${escape(duration(command.executionMs))}</td>
    <td>${escape(recent ? duration(command.cpuMs) : duration(command.elapsedMs))}</td><td>${escape(time(recent ? command.finishedAt : command.queuedAt))}</td></tr>`).join("");
}
function table(commands, recent = false) {
  if (!commands.length) return `<p class="small text-light-emphasis px-3">${recent ? "Todavía no hay operaciones registradas en esta ejecución." : "Sin operaciones en curso ni en cola."}</p>`;
  return `<div class="table-responsive"><table class="table table-sm table-dark align-middle mb-0"><thead><tr><th>Worker</th><th>Operación</th><th>Estado</th><th>Petición</th><th>Espera</th><th>Ejecución</th><th>${recent ? "CPU" : "Total"}</th><th>${recent ? "Terminó" : "Recibida"}</th></tr></thead><tbody>${rows(commands,recent)}</tbody></table></div>`;
}
function workerCard(worker, label, explanation, now) {
  const queue = worker.queue || {}, heartbeat = worker.worker?.heartbeatAt;
  const age = heartbeat && Number.isFinite(Date.parse(heartbeat)) ? Math.max(0,now-Date.parse(heartbeat)) : null;
  const percent = queue.maxBytes ? Math.min(100,Math.round(100*(queue.bytes || 0)/queue.maxBytes)) : 0;
  const rejected = worker.lastRejectedCommand;
  const bad = ["failed","closed"].includes(worker.state);
  return `<article class="diagnostic-item worker-operation-card"><div class="diagnostic-item-header"><strong>${label}</strong><span class="diagnostic-pill ${bad ? "error" : worker.state === "ready" ? "ok" : "idle"}">${escape(states[worker.state] || "No disponible")}</span></div>
    <p class="small text-light-emphasis mb-2">${explanation}</p>
    <div class="worker-operation-stats"><span><strong>${escape(queue.inFlight ?? "—")}</strong> en curso</span><span><strong>${escape(queue.pending ?? "—")}</strong> en cola</span><span><strong>${escape(worker.completed ?? "—")}</strong> operaciones completadas</span></div>
    <label class="small d-block mt-2">Presupuesto de peticiones: ${escape(bytes(queue.bytes))} / ${escape(bytes(queue.maxBytes))}<progress class="worker-queue-progress" max="100" value="${percent}" aria-label="Ocupación de la cola de ${label}"></progress></label>
    <div class="diagnostic-item-meta">Límite por comando: ${escape(bytes(queue.maxCommandBytes))} · Capacidad: ${escape(queue.maxItems ?? "—")} peticiones</div>
    <div class="diagnostic-item-meta">Fallidas: ${escape(worker.failed ?? "—")} · Rechazadas: ${escape(worker.rejected ?? "—")} · CPU activa: ${escape(queue.cpuInFlight ?? "—")} / ${escape(queue.maxCpuInFlight ?? "—")}</div>
    <div class="diagnostic-item-meta">Última ejecución: ${escape(duration(worker.lastExecutionMs))} · Espera: ${escape(duration(worker.lastQueueMs))} · CPU: ${escape(duration(worker.lastCpuMs))}</div>
    <div class="diagnostic-item-meta">Heartbeat: ${age === null ? "sin muestra" : `hace ${escape(duration(age))}`}${age > 15000 ? " · demorado; comprobar la operación activa" : ""}</div>
    <div class="diagnostic-item-meta">Último éxito: ${escape(time(worker.lastSuccessAt))} · Salida: ${escape(bytes(worker.lastOutputBytes))}</div>
    ${worker.lastErrorCode ? `<div class="text-warning small">Último error histórico (${escape(time(worker.lastErrorAt))}, ${escape(worker.lastErrorCategory || "sin clasificar")}): ${escape(worker.lastErrorCode)} · ${worker.activeErrors?.length || 0} errores sin éxito posterior en la misma operación</div>` : ""}
    <div class="diagnostic-item-meta">Fallos por clase: ${escape(Object.entries(worker.failuresByCategory || {}).map(([key,count])=>`${key}: ${count}`).join(" · "))}</div>
    ${rejected ? `<div class="worker-operation-rejection small">Último rechazo (${escape(time(rejected.finishedAt))}): ${escape(rejected.code)}<br>${escape([rejected.operation,rejected.service,rejected.method,rejected.kind].filter(Boolean).join(" / "))} · ${escape(bytes(rejected.bytes))} recibidos${rejected.code === "STORAGE_COMMAND_TOO_LARGE" ? `; límite ${escape(bytes(rejected.maxCommandBytes ?? queue.maxCommandBytes))}` : "; cola sin capacidad"}</div>` : ""}
  </article>`;
}

// Only metadata is rendered: commands never carry arguments, provider bodies or secrets here.
export function renderWorkerOperations(storage, {sampledAt, now = Date.now()} = {}) {
  if (!storage) return '<p class="small text-light-emphasis px-3">No hay telemetría de almacenamiento disponible en esta muestra.</p>';
  if (["disabled","new"].includes(storage.state)) return '<p class="small text-light-emphasis px-3">El almacenamiento SQLite está desactivado o todavía no ha iniciado.</p>';
  const workers = [[storage,"Escritor","Guarda los datos adquiridos y confirma las transacciones SQLite."], ...(storage.analysis ? [[storage.analysis,"Análisis","Lee SQLite y calcula proyecciones. Delega sus guardados al escritor."]] : [])];
  const active = workers.flatMap(([worker,workerLabel]) => [...(worker.activeCommands || []),...(worker.queuedCommands || [])].map(command => ({...command,workerLabel})));
  const recent = workers.flatMap(([worker,workerLabel]) => (worker.recentCommands || []).map(command => ({...command,workerLabel}))).sort((a,b) => Date.parse(b.finishedAt)-Date.parse(a.finishedAt)).slice(0,30);
  return `<p class="small text-light-emphasis px-3">Muestra: ${escape(time(sampledAt))} · Actualización cada 5 s con la pestaña visible. Contadores desde el arranque; últimos 50 resultados por worker.</p>
    <div class="worker-operation-grid">${workers.map(([worker,label,explanation]) => workerCard(worker,label,explanation,now)).join("")}</div>
    <h3 class="h6 px-3 mt-3">Operaciones en curso y en cola</h3>${table(active)}
    ${workers.some(([worker]) => worker.queuedCommandsTruncated) ? '<p class="small text-warning px-3">Se muestran las primeras 50 peticiones en cola por worker.</p>' : ""}
    <h3 class="h6 px-3 mt-3">Últimos resultados</h3>${table(recent,true)}
    <p class="small text-light-emphasis px-3 mt-2">Espera: tiempo hasta comenzar. Ejecución: tiempo dentro del worker, incluido I/O. CPU sólo se atribuye al análisis aislado; «—» indica una medida no disponible. El rechazo ocurre antes de ejecutar.</p>`;
}
