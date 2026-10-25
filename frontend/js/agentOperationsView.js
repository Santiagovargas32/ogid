const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text??'--');return e;};
const date=v=>v?new Date(v).toLocaleString():'--';
const counts=rows=>(rows||[]).map(r=>`${r.status}: ${r.count}`).join(' · ')||'sin ejecuciones';
const seconds=v=>Number.isFinite(v)?`${Math.round(v/1000)} s`:'--';
const labels={ready:'Disponible',running:'En ejecución',working:'Trabajando',waiting:'Esperando',available:'Disponible',responding:'Respondiendo',connected:'Conectado',starting:'Iniciando',pending:'Pendiente',restarting:'Recuperando',off:'Detenido',disabled:'Desactivado',unknown:'Desconocido',unverified:'Contrato sin verificar',degraded:'Degradado',stale:'Sin observación reciente'};
export function renderAgentRuntime(runtime={},target){
 if(!target)return;
 runtime ||= {};
 target.replaceChildren();target.style.display='grid';target.style.gridTemplateColumns='repeat(auto-fit,minmax(min(100%,16rem),1fr))';target.style.gap='.75rem';
 const cards=[['Broker',runtime.components?.broker],['OpenCode',runtime.components?.opencode],['MCP OGID',runtime.services?.mcp],['Worker',runtime.components?.worker],['llama.cpp / modelo',runtime.services?.llamacpp]];
 for(const [name,value]of cards){
  const c=value||{state:'unknown'},card=node('article');card.className='diagnostic-item';
  const head=node('div');head.className='diagnostic-item-header';head.append(node('strong',name));
  const t=c.telemetry||c;
  let observedState=runtime.observationLost?'unknown':c.state;
  if(observedState==='running')observedState=t.active||t.generations?.length?'working':runtime.recovery?.nextEligibleAt&&name==='Worker'?'waiting':t.sampledAt||t.checkedAt?'available':'unknown';
  const state=labels[observedState]||observedState||'Desconocido',badge=node('span',state);
  badge.className='diagnostic-pill '+(['ready','running','working','available','connected','responding'].includes(observedState)?'ok':['degraded'].includes(observedState)?'error':['waiting','starting','pending','restarting','unverified','stale'].includes(observedState)?'partial':'idle');head.append(badge);card.append(head);
  if(runtime.observationLost)card.append(node('p','Sin conexión con runtime; se conserva la última observación.'));
  if(c.pid)card.append(node('p',`PID ${c.pid}`));
  const lines=[c.errorCode&&`Proceso: ${c.errorCode}`,t.sampledAt&&`Observado: ${date(t.sampledAt)}`,t.checkedAt&&`Conexión comprobada: ${date(t.checkedAt)}`,t.version&&`Versión: ${t.version}`,t.apiState&&`API: ${labels[t.apiState]||t.apiState}`,t.resident&&`Residente: ${t.resident}`,t.model&&`Modelo: ${t.model}`,t.observedAt&&`Última comunicación: ${date(t.observedAt)}`,
   Number.isFinite(t.queue)&&`En cola: ${t.queue}`,Number.isFinite(t.rejections)&&`Rechazos observados: ${t.rejections}`,t.active&&`Solicitud ${t.active.requestId} · ${t.active.phase} · ${t.active.model}`,
   t.active?.queuedAt&&`Admitida ${date(t.active.startedAt)} · espera ${seconds(Date.parse(t.active.startedAt)-Date.parse(t.active.queuedAt))}`,
   t.active?.lastProgressAt&&`Progreso: ${date(t.active.lastProgressAt)}`,t.lastSuccess&&`Último éxito: ${date(t.lastSuccess.at)}`,
   t.lastFailure&&`Último fallo: ${t.lastFailure.causeCode||t.lastFailure.code} · ${date(t.lastFailure.at)}`,
   t.expectedContract&&`Contrato esperado: ${t.expectedContract.version||'desconocida'} · ${String(t.expectedContract.hash||'desconocido').slice(0,12)}`,
   t.identity&&`Contrato observado: ${t.identity.version||'desconocida'} · ${String(t.identity.hash||'desconocido').slice(0,12)}`,t.profile&&`Perfil: ${t.profile}`,t.permittedTools&&`Herramientas permitidas (${t.permittedTools.length}): ${t.permittedTools.join(', ')}`];
  for(const text of lines.filter(Boolean))card.append(node('p',text));
  if(name==='MCP OGID'&&!t.identity)card.append(node('p','Identidad pendiente de una respuesta del adaptador real.'));
  for(const g of t.generations||[])card.append(node('p',`${g.task} · ${g.phase} · job ${g.jobId} · fence ${g.fence} · ${g.toolsCompleted??'--'} herramientas · ${g.evidenceReads??'--'} lecturas · progreso ${date(g.lastProgressAt)}`));
  target.append(card);
 }
 if(runtime.recovery?.nextEligibleAt){const p=node('p',`${runtime.recovery.probe?'Comprobando recuperación':'Espera del modelo'}: ${runtime.recovery.model} · ${runtime.recovery.consecutiveFailures} fallos consecutivos · próxima elegibilidad ${date(runtime.recovery.nextEligibleAt)}`);p.style.gridColumn='1 / -1';target.append(p);}
}
export function renderAgentOperations(data,{process,activity,publications,updated}={}) {
 if(updated)updated.textContent=`Actualizado ${date(data.sampledAt)} · arranque ${date(data.since)}`;
 if(process){
  renderAgentRuntime(data.runtime,process);
  const prerequisites=node('div');prerequisites.style.gridColumn='1 / -1';
  prerequisites.append(node('p',`Prerequisitos: ${data.worker?.state||'sin telemetría'} · ${data.worker?.currentDomain||'sin cálculo activo'}`),node('p',`Último éxito de prerequisitos: ${date(data.worker?.lastSuccessAt)}`),node('p',`Tareas: ${Object.entries(data.taskModes||{}).map(([k,v])=>`${k}: ${v}`).join(' · ')}`));
  process.append(prerequisites);
 }
 if(activity){
  activity.replaceChildren(node('p',`Ejecuciones de este arranque: ${counts(data.sinceCounts)}`),node('p',`Trabajos acumulados: ${counts(data.jobs)}`),node('p',`Publicaciones durables: ${data.publicationCount??'--'} · Pendiente más antiguo: ${date(data.queueAge?.oldestQueuedAt)}`));
  const c=data.current;
  if(c){
   const summary=node('article');summary.className='diagnostic-item';summary.append(node('h3','Resultado de este arranque'),node('p',`${c.publications} publicaciones nuevas válidas · ${c.completed??'--'} ejecuciones completadas · ${c.failed} fallidas · ${c.active} activas · ${c.executions} iniciadas`),node('p',`${c.candidates} candidatos · ${c.repairs} reparaciones intentadas · ${c.evidenceReads} ejecuciones con lectura acreditada${c.evidenceReadUnknown?` · ${c.evidenceReadUnknown} sin telemetría de lectura`:''}`),node('p',`Último éxito: ${date(c.lastSuccessAt)} · último fallo: ${date(c.lastFailureAt)}`));
   for(const f of c.failures||[])summary.append(node('p',`${f.causeCode}: ${f.count}`));activity.prepend(summary);
  }
  if(data.proposalMetrics){
   const metrics=data.proposalMetrics;
   activity.append(node('p',`Validación: ${metrics.sampled} ejecuciones recientes${metrics.truncated?' (ventana limitada)':''} · sin telemetría de propuesta: ${metrics.excluded}`));
   for(const group of metrics.groups||[])
    activity.append(node('p',`${group.task} · ${group.model}: conformes inicialmente ${group.initialValid}/${group.initialAssessed}; reparaciones válidas ${group.repairValid}/${group.repairAssessed} evaluadas, ${group.repairAttempts} intentadas; resultado desconocido ${group.initialUnknown} iniciales / ${group.repairUnknown} reparaciones.`));
  }
  const wrap=node('div');wrap.className='table-responsive';const table=node('table');table.className='table table-sm table-dark align-middle';
  const head=node('tr');for(const label of ['Tarea / ámbito','Estado / fase','Modelo','Antigüedad','Progreso','Error','Job / snapshot'])head.append(node('th',label));const thead=node('thead');thead.append(head);table.append(thead);const body=node('tbody');table.append(body);
  for(const j of data.recentJobs||[]){
   const run=(data.runs||[]).find(r=>r.jobId===j.jobId&&r.fence===j.fence),m=run?.metadata||{},row=node('tr');
   const elapsed=Math.max(0,Date.parse(run?.finishedAt||data.sampledAt)-Date.parse(run?.startedAt||j.createdAt));
   const progress=`${m.toolsCompleted??"--"} herramientas · primera señal ${seconds(m.firstProgressMs)} · actividad ${date(m.lastProgressAt)}`;
   const repairs=m.validation?.repairAttempted?' · reparación única intentada':'';
   const failure=[j.errorCode,m.terminalError?.causeCode,m.lastToolFailure&&`MCP: ${m.lastToolFailure.operationId||'herramienta'} · ${m.lastToolFailure.code}`].filter(Boolean).join(' · ')||'--';
   for(const text of [`${j.task} · ${j.scope}`,`${j.status}${m.phase?` · fase ${m.phase}`:''}${repairs}`,j.model,seconds(elapsed),progress,failure,`${j.jobId} · fence ${j.fence} · ${j.snapshotId||'sin snapshot'} · generación ${m.generation?.key||'desconocida'} · contrato MCP ${m.mcpContractHash||m.effectiveContract?.mcpHash||'desconocido'}`])row.append(node('td',text));
   if(m.lastToolFailure||m.terminalError){const details=node('details');details.append(node('summary','Fase y validación'));const pre=node('pre',JSON.stringify({phase:m.phase,terminal:m.terminalError||null,mcp:m.lastToolFailure||null,validation:m.validation||null},null,2));pre.style.whiteSpace='pre-wrap';details.append(pre);row.children[5].append(details);}
   body.append(row);
  }
  wrap.append(table);activity.append(wrap);
  if(data.truncated||data.runs?.some(r=>r.metadata?.truncated))activity.append(node('p','Respuesta acotada: algunos detalles extensos se omiten.'));
  if(!data.recentJobs?.length)activity.append(node('p','No hay trabajos registrados.'));
 }
 if(publications){
  publications.replaceChildren(node('h3','Respuestas validadas del agente'));
  publications.append(node('p','Shadow: resultados experimentales conservados para revisión; las rutas públicas los ocultan.'));
  if(!data.recentPublications?.length)publications.append(node('p','Todavía no hay publicaciones validadas. Revisa el estado y los errores de los trabajos.'));
  for(const p of data.recentPublications||[]){
   const article=node('article');article.className='diagnostic-item';
   article.append(node('h4',`${p.mode} · ${p.proposal?.task||'publicación'} · ${date(p.publishedAt)}`),node('p',p.proposal?.summary),node('p',`Modelo ${p.model} · evidencia a ${date(p.evidenceAsOf)} · citas ${p.coverage?.citedEvidenceCount??'--'} / ${p.coverage?.evidenceCount??'--'}`));
   const details=node('details');details.append(node('summary','Ver respuesta, límites y referencias congeladas'));
   const pre=node('pre',JSON.stringify({publicationId:p.publicationId,jobId:p.jobId,snapshotId:p.snapshotId,promptVersion:p.promptVersion,coverage:p.coverage,proposal:p.proposal},null,2));pre.style.whiteSpace='pre-wrap';details.append(pre);article.append(details);publications.append(article);
  }
 }
}
