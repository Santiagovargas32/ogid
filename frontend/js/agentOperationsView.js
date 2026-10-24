const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text??'--');return e;};
const date=v=>v?new Date(v).toLocaleString():'--';
const counts=rows=>(rows||[]).map(r=>`${r.status}: ${r.count}`).join(' · ')||'sin ejecuciones';
const seconds=v=>Number.isFinite(v)?`${Math.round(v/1000)} s`:'--';
export function renderAgentOperations(data,{process,activity,publications,updated}={}) {
 if(updated)updated.textContent=`Actualizado ${date(data.sampledAt)} · arranque ${date(data.since)}`;
 if(process){
  process.replaceChildren();
  for(const [name,c] of Object.entries(data.runtime?.components||{})){
   process.append(node('p',`${name}: ${c.state} · PID ${c.pid??'--'}${c.errorCode?` · ${c.errorCode}`:''}`));
  }
  process.append(node('p',`Prerequisitos: ${data.worker?.state||'sin telemetría'} · ${data.worker?.currentDomain||'sin cálculo activo'}`));
  process.append(node('p',`Último éxito de prerequisitos: ${date(data.worker?.lastSuccessAt)}`));
  process.append(node('p',`Tareas: ${Object.entries(data.taskModes||{}).map(([k,v])=>`${k}: ${v}`).join(' · ')}`));
 }
 if(activity){
  activity.replaceChildren(node('p',`Ejecuciones de este arranque: ${counts(data.sinceCounts)}`),node('p',`Trabajos acumulados: ${counts(data.jobs)}`),node('p',`Publicaciones durables: ${data.publicationCount??'--'} · Pendiente más antiguo: ${date(data.queueAge?.oldestQueuedAt)}`));
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
   const repairs=m.validationAttempts?.length?` · reparación ${m.validationAttempts.length}`:'';
   for(const text of [`${j.task} · ${j.scope}`,`${j.status}${m.phase?` · fase ${m.phase}`:''}${repairs}`,j.model,seconds(elapsed),progress,m.lastToolFailure?`${m.lastToolFailure.operationId||'MCP'} · ${m.lastToolFailure.code} · ${(m.lastToolFailure.validation?.issues||[]).map(i=>i.path.join('.')+':'+i.code).join(', ')}`:j.errorCode||'--',`${j.jobId} · fence ${j.fence} · ${j.snapshotId||'sin snapshot'} · generación ${m.generation?.key||'desconocida'} · contrato MCP ${m.mcpContractHash||m.effectiveContract?.mcpHash||'desconocido'}`])row.append(node('td',text));
   body.append(row);
  }
  wrap.append(table);activity.append(wrap);
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
