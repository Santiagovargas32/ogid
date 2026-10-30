import {request} from './api.js';
const byId=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const status=byId('analyst-status'),results=byId('analyst-results'),jobs=byId('analyst-jobs'),more=byId('analyst-more');
const situation=byId('analyst-situation'),baseline=byId('analyst-baseline');
situation.value=new URLSearchParams(location.search).get('situationId')||'';
let cursor=null,generation=0,busy=false,pending=null;
const sections={synthesis:'Síntesis',timeline:'Cronología',changes:'Cambios',impacts:'Impactos',contradictions:'Contradicciones',limitations:'Limitaciones',missingEvidence:'Evidencia faltante'};
async function read(path,query={}){return request(path,query);}
async function evidence(parent,analysis,id){
 const target=node('pre','Consultando evidencia…');target.style.whiteSpace='pre-wrap';target.style.overflowWrap='anywhere';parent.append(target);
 try{let offset=0,text='';for(;;){const page=await read('/api/agent/v1/evidence/chunk',{snapshotId:analysis.snapshotId,evidenceId:id,offset,format:'utf8'});text+=page.chunk;if(!page.hasMore)break;offset=page.nextOffset;}target.textContent=text;}catch(error){target.textContent=error.message;}
}
async function section(parent,analysis,key,cursor){
 const button=node('button',cursor?'Cargar más':'Consultar '+sections[key]);button.type='button';parent.append(button);
 button.onclick=async()=>{button.disabled=true;try{
  const page=await read(`/api/admin/situation-analyses/${encodeURIComponent(analysis.analysisId)}/sections`,{section:key,...(cursor?{cursor}:{})});
  for(const row of page.items){const block=node('article');block.append(node('p',typeof row==='string'?row:row.text));if(typeof row!=='string'){
   for(const field of ['kind','occurredAt','publishedAt','knownAt','channel','instrumentId','mechanism','confirmation','invalidation'])if(row[field]!=null)block.append(node('p',`${field}: ${row[field]}`));
   for(const id of row.evidenceIds||[]){const cite=node('button',id);cite.type='button';cite.onclick=()=>void evidence(block,analysis,id);block.append(cite);}
  }parent.append(block);}
  button.remove();if(page.hasMore)await section(parent,analysis,key,page.nextCursor);
 }catch(error){status.textContent=error.message;button.disabled=false;}};
}
async function load(append=false){if(busy)return;busy=true;const current=++generation;
 try{const page=await read('/api/admin/situation-analyses',{...(situation.value?{situationId:situation.value}:{}),...(append&&cursor?{cursor}:{})});if(current!==generation)return;
  if(!append)results.replaceChildren();jobs.replaceChildren();for(const job of page.jobs||[])jobs.append(node('p',`${job.jobId}: ${job.status}${job.errorCode?' · '+job.errorCode:''}`));
  for(const analysis of page.items){const card=node('article');card.className='source-card';card.append(node('h2',analysis.situationId),node('p',`${analysis.analysisId} · shadow · ${analysis.status}`),node('p',analysis.summary),node('p',analysis.sourceCurrentness.updateAvailable?'Hay cambios posteriores al corte.':'Sin cambios posteriores registrados.'),node('p',`Cobertura ${analysis.coverage.partial?'parcial':'del corte seleccionado'} · ${analysis.coverage.capturedSources} fuentes · secuencia ${analysis.coverage.domainSequence}`));
   const compare=node('button','Usar como base de comparación');compare.onclick=()=>{baseline.value=analysis.analysisId;};card.append(compare);
   for(const key of Object.keys(sections)){const block=node('section');block.append(node('h3',sections[key]));card.append(block);await section(block,analysis,key);}
   results.append(card);
  }
  cursor=page.nextCursor;more.hidden=!page.hasMore;status.textContent=page.items.length?'Lectura completada.':'No hay resultados para esta situación.';
 }catch(error){status.textContent=error.message;}finally{busy=false;}}
byId('analyst-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;
 try{const input={situationId:situation.value,...(baseline.value?{baselineAnalysisId:baseline.value}:{})};if(!pending||JSON.stringify(pending.input)!==JSON.stringify(input))pending={input,requestId:crypto.randomUUID()};
  const response=await fetch('/api/admin/situation-analyses',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({...input,requestId:pending.requestId})});const value=await response.json();if(!response.ok)throw new Error(value.error?.message||value.error?.code||`HTTP ${response.status}`);pending=null;await load();status.textContent=`Trabajo solicitado: ${value.data.jobId}. Actualiza el estado para consultar el resultado.`;
 }catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
byId('analyst-refresh').onclick=()=>void load();more.onclick=()=>void load(true);
void load();
