import {request} from './api.js';
const byId=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const root=byId('situation-items'),status=byId('situation-status'),engine=byId('situation-engine-status'),more=byId('situation-more');
const query=new URLSearchParams(location.search),entityId=query.get('id'),atSequence=query.has('atSequence')?Number(query.get('atSequence')):undefined;
const modality={reported:'relato atribuido',negated:'negación',prospective:'futuro o amenaza',opinion:'opinión',mixed:'modalidad mixta',unknown:'modalidad desconocida',retracted:'retirado o corregido'};
const verification={unverified:'sin verificar','needs-review':'necesita revisión','reviewed-supported':'apoyo atribuido al revisor','reviewed-disputed':'disputado por el revisor',retracted:'retirado'};
const changes={'new-report':'nuevo reporte','source-corrected':'fuente corregida','metadata-updated':'metadatos actualizados','evidence-reviewed':'evidencia revisada','historical-indexed':'incorporación histórica','context-changed':'contexto reorganizado'};
let cursor=null,busy=false,filters={},generation=0,controller;
function paragraph(parent,text){parent.append(el('p',text));}
function link(label,path,external=false){const a=el('a',label);try{const u=new URL(path,location.origin);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return el('span',label);a.href=u.href;if(external){a.target='_blank';a.rel='noopener noreferrer';}}catch{return el('span',label);}return a;}
function dates(parent,item){paragraph(parent,`Hecho: ${item.occurredAt||'fecha no establecida'} · Publicación: ${item.publishedAt||'desconocida'} · Recepción: ${item.receivedAt||'desconocida'}`);paragraph(parent,`Cambió el conocimiento: ${item.changedAt||'desconocido'} · Disponible: ${item.availableAt||'desconocido'}`);}
function card(item){const n=el('article');n.tabIndex=-1;n.append(el('h3',item.title||'Contexto sin título'));paragraph(n,`${item.kind==='incident'?'Incidente revisado':'Situación de cobertura candidata'} · ${verification[item.verification]||item.verification} · r${item.revision}`);paragraph(n,changes[item.changeKind]||item.changeKind);if(item.historical)paragraph(n,'Indexación histórica: esta incorporación no acredita un hecho reciente.');paragraph(n,modality[item.modality]||'Modalidad atribuida a las evidencias');dates(n,item);if(item.currentness?.current===false)paragraph(n,'Hay fuentes corregidas desde la revisión citada. La interpretación necesita reevaluación.');if(item.summary)paragraph(n,item.summary);n.append(link('Abrir evidencias e historial',`/situations.html?${new URLSearchParams({id:item.id})}`));return n;}
function evidence(item){const n=el('article');n.tabIndex=-1;n.append(el('h3',item.title||item.sourceId));paragraph(n,`${item.stream} · revisión ${item.sourceRevision} · ${item.currentAtCut?'vigente en esta lectura':'histórica; fuente revisada'}`);paragraph(n,`Editor: ${item.publisherId||'pendiente'} · Origen: ${item.originChainId||'desconocido'} · ${modality[item.modality]||'modalidad desconocida'}`);paragraph(n,`Idioma: ${item.language||'desconocido'} · ${item.classificationStatus||'pendiente'} · Texto: ${item.textScope||'declaración de la fuente'}`);if(item.sourceUrl)n.append(link('Fuente original',item.sourceUrl,true));if(item.candidateGroupId)n.append(el('br'),link('Comparar publicaciones y afirmaciones',`/comparisons.html?${new URLSearchParams({groupId:item.candidateGroupId})}`));return n;}
async function loadHistory(target,button,next){
 const focused=document.activeElement===button;
 button.disabled=true;
 try{
  const data=await request(`/api/situations/${encodeURIComponent(entityId)}/revisions`,{limit:10,maxBytes:65536,...(next?{cursor:next}:{})});
  let first;
  for(const item of data.items){const n=el('article');n.tabIndex=-1;paragraph(n,`Revisión ${item.revision} · ${changes[item.changeKind]||item.changeKind} · ${item.changedAt}`);if(item.lastReview)paragraph(n,`${item.lastReview.reviewer}: ${item.lastReview.reason}`);n.append(link('Ver este estado y sus evidencias',`/situations.html?${new URLSearchParams({id:entityId,atSequence:item.sequence})}`));target.append(n);first ||= n;}
  if(data.hasMore){button.textContent='Más cambios históricos';button.onclick=()=>void loadHistory(target,button,data.nextCursor);}else{button.hidden=true;if(focused&&first)first.focus({preventScroll:true});}
 }catch{paragraph(target,'No se pudo consultar el historial; puedes reintentar.');}
 finally{button.disabled=false;if(focused&&!button.hidden)button.focus({preventScroll:true});}
}
async function engineStatus(){
 try{const s=await request('/api/situations/status');if(s.available===false){engine.textContent='Seguimiento no disponible en esta instalación.';return;}
 const pending=s.streams?.filter(x=>x.hasMore).map(x=>`${x.stream}: procesado ${x.lastSequence}, último disponible ${x.headSequence}`)||[];
 engine.textContent=s.errorCode?`Seguimiento detenido en una entrada: ${s.errorCode}. Los pendientes se conservan.`:!s.initialized?'Preparando el histórico por páginas; la cobertura está incompleta.':pending.length?`Procesando cambios pendientes. ${pending.join(' · ')}`:'Sin cambios pendientes en los registros recogidos. La cobertura de fuentes sigue siendo parcial.';
 }catch{engine.textContent='No se pudo consultar el estado del seguimiento. Esto no indica ausencia de noticias o incidentes.';}
}
async function load(append=false){
 if(busy&&append)return;
 const focused=document.activeElement===more,y=window.scrollY;
 const token=++generation;controller?.abort();controller=new AbortController();busy=true;more.disabled=true;byId('situation-refresh').disabled=true;
 try{
  if(!append){cursor=null;const end=new Date(),hours=byId('situation-window').value;filters={kind:byId('situation-kind').value,timeField:byId('situation-time').value,...(hours==='all'?{}:{from:new Date(end-Number(hours)*3600000).toISOString(),to:end.toISOString()})};}
  const data=entityId?await request(`/api/situations/${encodeURIComponent(entityId)}`,{limit:10,maxBytes:65536,atSequence,...(cursor?{cursor}:{})},{signal:controller.signal}):await request('/api/situations',{...filters,limit:12,maxBytes:65536,...(cursor?{cursor}:{})},{signal:controller.signal});
  if(token!==generation)return;
  if(!append)root.replaceChildren();
  let firstNew=null;
  if(entityId&&!append){const head=card(data.entity);root.append(head);paragraph(head,`Lectura al corte ${data.asOfSequence}.`);const history=el('section'),historyButton=el('button','Historial de cambios');historyButton.type='button';historyButton.onclick=()=>void loadHistory(history,historyButton);head.append(historyButton,history);}
  if(entityId)for(const relation of data.relations||[]){const n=el('p');n.append(link('Contexto o incidente asociado',`/situations.html?${new URLSearchParams({id:relation.id})}`));root.append(n);}
  for(const item of data.items||[]){const n=entityId?evidence(item):card(item);root.append(n);firstNew ||= n;}
  cursor=data.nextCursor;more.hidden=!data.hasMore;
  status.textContent=data.available===false?'Esta instalación no dispone del seguimiento SQLite.':`${entityId?'Evidencias':'Situaciones'} al corte ${data.asOfSequence}. ${data.hasMore?'Hay más resultados.':'Lectura terminada.'}`;
  if(!data.items?.length&&!append)paragraph(root,entityId?'Sin evidencias registradas para esta lectura.':'Sin resultados para este filtro. Una fecha de hecho desconocida no equivale a ausencia de sucesos.');
  if(focused&&more.hidden&&firstNew)firstNew.focus({preventScroll:true});
  window.scrollTo({top:y,behavior:'auto'});
 }catch(error){if(token===generation&&error.code!=='REQUEST_CANCELLED')status.textContent=`No se pudo cargar la lectura (${error.code||'error de conexión'}). Puedes reintentar.`;}
 finally{if(token===generation){busy=false;more.disabled=false;byId('situation-refresh').disabled=false;}}
}
if(entityId){for(const label of byId('situation-controls').querySelectorAll('label'))label.hidden=true;byId('situation-heading').textContent='Situación y evidencias atribuidas';}
else for(const id of ['situation-kind','situation-time','situation-window'])byId(id).onchange=()=>void load(false);
byId('situation-refresh').onclick=()=>void load(false);more.onclick=()=>void load(true);
let statusTimer;
function schedule(){clearTimeout(statusTimer);if(document.hidden)return;statusTimer=setTimeout(async()=>{await engineStatus();schedule();},15000);}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(statusTimer);else{void engineStatus();schedule();}});
window.addEventListener('pagehide',()=>{clearTimeout(statusTimer);controller?.abort();});
void load();void engineStatus();schedule();

if(entityId){const a=link('Revisar análisis shadow',`/analyst.html?situationId=${encodeURIComponent(entityId)}`);document.querySelector('main').append(a);}
