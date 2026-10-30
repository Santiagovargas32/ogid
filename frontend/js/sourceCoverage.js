import {request} from './api.js';
import {sourceAssessmentLabel} from './sourceAssessmentModel.js';
const byId=id=>document.getElementById(id);
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
const query=new URLSearchParams(location.search);
const filters={...(query.get('publisherId')?{publisherIds:[query.get('publisherId')]}:{}),...(query.get('edition')?{edition:query.get('edition')}:{}),...(query.get('politicalScope')?{politicalScope:query.get('politicalScope')}:{} )};
let cut={},cursor=null,loading=false;
function link(label,href){const a=node('a',label);try{const url=new URL(href);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return node('span',`${label}: referencia no disponible`);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';}catch{return node('span',label);}return a;}
function paragraph(parent,text){parent.append(node('p',text));}
function renderCoverage(data){
  const root=byId('coverage-summary');root.replaceChildren();
  if(!data.summary){paragraph(root,'Cobertura no disponible en este almacenamiento.');return;}
  const s=data.summary,dl=node('dl');
  for(const [label,value] of [['Publicaciones',s.articles],['Editores resueltos',s.publishers],['Artículos con editor desconocido',s.unknownPublisherArticles],['Grupos propietarios conocidos',s.ownerGroups],['Artículos con propietario desconocido',s.unknownOwnerArticles],['Identificadores de cadena de origen',s.knownOriginChains],['Artículos con origen desconocido',s.unknownOriginArticles],['Artículos sin país editorial conocido',s.unknownEditorialCountryArticles],['Artículos con perfil documental',s.profiledArticles??0],['Artículos con evaluación propia publicada',s.publishedEvaluationArticles??0],['Editores con expediente elaborado (incluye pendientes de revisión)',s.evaluatedSubjects??0]])dl.append(node('dt',label),node('dd',String(value)));
  root.append(dl);
  paragraph(root,`Recepción: ${data.window.from} — ${data.window.to}. Cobertura ${data.coverage.partial?'parcial':'completa para esta ventana'}; ${data.coverage.pendingFacetArticles} artículos pendientes de metadatos.`);
  paragraph(root,`Idiomas observados: ${data.languages.map(x=>`${x.language}: ${x.articles}`).join(' · ')||'sin datos'}${data.coverage.languageGroupsPartial?' (lista parcial)':''}.`);
  paragraph(root,`Menciones de países clasificadas en publicaciones: ${data.mentionedCountries.map(x=>`${x.country}: ${x.articles}`).join(' · ')||'sin datos'}${data.coverage.countryGroupsPartial?' (lista parcial)':''}. No son localizaciones verificadas de incidentes; una publicación puede mencionar varios países.`);
  paragraph(root,`Países editoriales documentados: ${data.editorialCountries.map(x=>`${x.country}: ${x.articles}`).join(' · ')||'desconocidos'}. Un artículo puede pertenecer a varios países editoriales.`);
  paragraph(root,`Catálogo: ${data.catalogue.entries} entradas, ${data.catalogue.enabledEntries} habilitadas, ${data.catalogue.generatedSearches} búsquedas configuradas. La salud de las fuentes del piloto se detalla abajo.`);
  paragraph(root,`Idiomas declarados en el catálogo: ${data.configuredLanguages.map(x=>`${x.language}: ${x.entries}`).join(' · ')}. No demuestran el idioma observado.`);
  for(const region of data.plannedRegions)paragraph(root,`${region.region}: ${region.configuredQueries} consultas configuradas; su cantidad no acredita cobertura de reportería.`);
  for(const pilot of data.pilots||[]){
    root.append(node('h3',pilot.label));
    paragraph(root,`${pilot.configured} fuentes configuradas · ${pilot.enabled} habilitadas · ${pilot.consulted} consultadas · ${pilot.healthy} con salud reciente. Estado de adquisición a ${pilot.observedAt}.`);
    paragraph(root,`Búsquedas de descubrimiento: ${pilot.discoveryQueries.configured} configuradas, ${pilot.discoveryQueries.consulted} consultadas y ${pilot.discoveryQueries.healthy} con salud reciente. Las búsquedas no son editores.`);
    const s=pilot.archiveSample;paragraph(root,`Muestra por menciones de país (${pilot.selection.countryMentions.join(', ')}): ${s.articles} publicaciones${s.partial?' de las 1.000 más recientes; muestra parcial':''}, ${s.publishers} editores, ${s.unknownPublisherArticles} con editor desconocido. No acredita ubicación de incidentes ni coordenadas marítimas.`);
    paragraph(root,`Idiomas: ${s.languages.map(x=>`${x.language}: ${x.articles}`).join(' · ')||'sin datos'}. Reportes adicionales con cadena de origen compartida: ${s.sharedOriginReports}; origen desconocido: ${s.unknownOriginArticles}. No equivalen a corroboraciones independientes.`);
    paragraph(root,`Publicación → recepción: p95 ${s.publicationToReception.p95Ms===null?'sin datos':`${Math.round(s.publicationToReception.p95Ms/1000)} s`} sobre ${s.publicationToReception.samples} fechas válidas de la muestra. RU/UK pendientes de evaluación propia.`);
    const details=node('details');details.append(node('summary','Estado de las fuentes'));for(const source of pilot.sources)paragraph(details,`${source.name} · ${source.enabled?'habilitada':'deshabilitada'} · ${source.health} · última consulta ${source.lastAttemptAt||'sin consultar'} · HTTP ${source.httpStatus??'desconocido'}`);root.append(details);
  }
  paragraph(root,'Los metadatos editoriales son los derivados actuales; esta ventana no reconstruye su estado histórico.');
  for(const publisher of data.publishers)paragraph(root,`${publisher.name}${publisher.edition?` (${publisher.edition})`:''}: ${publisher.articles} publicaciones · última recepción ${publisher.lastReceivedAt} · ${sourceAssessmentLabel({status:publisher.assessmentStatus,rating:publisher.rating}).label}.`);
}
function renderSubject(row){
  const card=node('article');card.append(node('h3',row.name));paragraph(card,`Edición: ${row.edition}`);
  paragraph(card,sourceAssessmentLabel(row).text);
  if(row.ownEvaluation){const e=row.ownEvaluation;paragraph(card,`Evaluación propia ${e.methodVersion}, revisión ${e.revision}. Muestra: ${e.sampleSize} publicaciones; corte ${e.asOf}. Revisada por ${e.reviewer} el ${e.reviewedAt}.`);for(const [key,c]of Object.entries(e.journalism))paragraph(card,`${criterionNames[key]||key}: ${statusNames[c.status]||c.status}. ${c.summary} Observaciones: ${c.observations}; problemas: ${c.problems}; no observables: ${c.unobservable}.`);const a=node('a','Ver expediente, evidencia y muestra');a.href=sourceAssessmentLabel(row).href;card.append(a);}
  paragraph(card,`Evaluaciones vigentes: ${row.evaluationCount}${row.partial?' o más; lectura parcial':''}.`);
  const p=row.profile;
  paragraph(card,`Propietario: ${p?.ownerGroupName||'desconocido'} · países editoriales: ${p?.editorialCountries.join(', ')||'desconocidos'} · idiomas del medio: ${p?.languages.join(', ')||'desconocidos'}.`);
  if(p){paragraph(card,`Perfil revisado: ${p.verifiedAt}, revisión ${p.revision}. Uso declarado por el importador: ${p.usagePermission.basis} · ${p.usagePermission.reference}.`);for(const ref of p.evidenceUrls)card.append(link('Referencia del perfil',ref),document.createTextNode(' '));}
  const a=node('a','Ver todas las evaluaciones y su procedencia');a.href=`/sources.html?${new URLSearchParams({publisherId:row.publisherId,edition:row.edition})}`;paragraph(card,'');card.append(a);return card;
}
function renderRecord(row){
  const card=node('article');card.append(node('h3',`${row.evaluatorName} · ${row.edition}`));
  paragraph(card,`${row.state==='withdrawn'?'Retirada':'Publicada'} · ${row.assessmentId} · revisión ${row.revision}. Etiqueta original: ${row.originalRating}. Escala: ${row.scaleVersion}.`);
  paragraph(card,sourceAssessmentLabel({status:row.rating==='unmapped'?'unmapped':row.rating==='not-applicable'?'not-applicable':'rated',rating:row.rating,evaluations:[row]}).text);
  paragraph(card,`Evaluada: ${row.assessedAt}. Vigencia: ${row.validFrom} — ${row.validUntil||'abierta'}. Registrada en OGID: ${row.recordedAt}.`);
  card.append(link(`Método ${row.methodId} · ${row.methodVersion}`,row.methodUrl));paragraph(card,`Licencia declarada: ${row.licenseName}. Uso declarado por el importador: ${row.usagePermission.basis} · ${row.usagePermission.reference}.`);
  card.append(link('Condiciones de uso',row.licenseUrl));for(const ref of row.evidenceUrls){paragraph(card,'');card.append(link('Evidencia de la evaluación',ref));}return card;
}
async function records(){
  const more=byId('records-more');more.disabled=true;
  try{
    const page=await request('/api/news/source-assessments',{...filters,...cut,view:'records',cursor:cursor||undefined,limit:20,maxBytes:65536});
    for(const row of page.items)byId('assessment-records').append(renderRecord(row));
    cursor=page.nextCursor;more.hidden=!page.hasMore;
    if(!page.items.length&&!cursor&&!byId('assessment-records').children.length)paragraph(byId('assessment-records'),'No hay evaluaciones autorizadas para este corte y filtro.');
  }finally{more.disabled=false;}
}
async function refresh(){
  if(loading)return;loading=true;byId('sources-refresh').disabled=true;byId('records-more').disabled=true;
  const status=byId('sources-status');status.textContent='Consultando datos almacenados…';
  try{
    const to=new Date().toISOString(),from=new Date(Date.parse(to)-Number(byId('coverage-window').value)*3600000).toISOString();cut={asOf:to,knownAt:to};
    const coverage=await request('/api/news/source-coverage',{from,to,maxBytes:65536});renderCoverage(coverage);
    const items=[];let next;
    do{const page=await request('/api/news/source-assessments',{...filters,...cut,cursor:next,limit:20,maxBytes:65536});items.push(...page.items.map(row=>page.available===false?{...row,status:'unavailable'}:row));next=page.nextCursor;if(page.hasMore&&!next)throw Error('Paginación incompleta');}while(next);
    byId('publisher-assessments').replaceChildren(...items.map(renderSubject));
    byId('records-filter').textContent=`Corte de vigencia y conocimiento: ${to}. ${filters.publisherIds?`Editor: ${filters.publisherIds[0]}, edición: ${filters.edition||'todas'}.`:'Todos los editores registrados.'}`;
    byId('assessment-records').replaceChildren();cursor=null;await records();status.textContent=`Lectura completada a ${to}.`;
  }catch(error){status.textContent=`Lectura incompleta: ${error.message}. Los datos anteriores, si existen, conservan su fecha.`;}
  finally{loading=false;byId('sources-refresh').disabled=false;}
}
byId('sources-refresh').addEventListener('click',refresh);byId('coverage-window').addEventListener('change',refresh);
byId('records-more').addEventListener('click',()=>{void records().catch(error=>{byId('sources-status').textContent=`No se pudo continuar: ${error.message}`;});});
const criterionNames={attribution:'Atribución',verifiability:'Verificabilidad','time-and-place':'Precisión temporal y geográfica','content-labels':'Información, opinión y publicidad',corrections:'Correcciones'};
const statusNames={backed:'prácticas respaldadas',mixed:'resultados mixtos',problems:'problemas documentados','insufficient-evidence':'evidencia insuficiente'};
async function dossier(){
  const id=query.get('dossierId');if(!id)return;const root=byId('assessment-records');root.replaceChildren();byId('records-more').hidden=true;
  let frozen={},revision=query.get('revision')?Number(query.get('revision')):undefined;
  const read=(section,cursor)=>request('/api/news/source-evaluations/'+encodeURIComponent(id),{revision,...frozen,section,cursor,limit:10,maxBytes:65536});
  try{const overview=await read('overview');frozen={asOf:overview.asOf,knownAt:overview.knownAt};revision=overview.revision;root.append(node('h3',`Expediente ${id} · revisión ${revision}`));paragraph(root,`Método ${overview.methodVersion}. Revisor: ${overview.reviewer}. Corte: ${overview.asOf}. Muestra: ${overview.sampleSize}.`);paragraph(root,overview.selection);paragraph(root,`Evaluación política (${overview.political.scope}): ${overview.political.summary}`);for(const [key,c]of Object.entries(overview.journalism))paragraph(root,`${criterionNames[key]}: ${statusNames[c.status]}. ${c.summary}`);for(const limitation of overview.limitations)paragraph(root,limitation);
    for(const [section,label]of [['evidence','Referencias y procedencia'],['sample','Muestra de publicaciones'],['observations','Observaciones por criterio']]){const box=node('section');box.append(node('h4',label));const button=node('button','Cargar página');let cursor;button.addEventListener('click',async()=>{button.disabled=true;try{const page=await read(section,cursor);for(const item of page.items){const card=node('article');if(item.url)card.append(link(item.title||item.id,item.url));paragraph(card,item.note||`${criterionNames[item.criterion]||item.type||item.basis} · ${item.outcome||item.textScope||''}`);if(item.publishedAt)paragraph(card,`Publicación: ${item.publishedAt} · recepción: ${item.receivedAt}`);if(item.evidenceIds)paragraph(card,`Referencias: ${item.evidenceIds.join(', ')||'sin evidencia observable'}`);box.insertBefore(card,button);}cursor=page.nextCursor;button.hidden=!page.hasMore;}catch(e){paragraph(box,e.message);}finally{button.disabled=false;}});box.append(button);root.append(box);}
    byId('sources-status').textContent='Expediente revisado disponible. Las referencias se cargan por páginas.';
  }catch(e){byId('sources-status').textContent=`No se pudo consultar el expediente: ${e.message}`;}
}
if(query.get('method')==='ogid-source-review-v1'){
 const root=byId('assessment-records');root.replaceChildren(node('h3','Método OGID de evaluación de fuentes · v1'));paragraph(root,'Evaluación propia por edición y contexto, elaborada bajo demanda y publicada únicamente después de revisión humana de la revisión y su hash. Perfil documental, orientación política, prácticas periodísticas y salud de adquisición se interpretan por separado.');paragraph(root,'Muestra de hasta 30 publicaciones en 90 días, selección temporal reproducible y deduplicación por origen conocido. Diez piezas utilizables son el mínimo para una conclusión política respaldada; no garantizan representatividad. Titulares y extractos no certifican la precisión de los hechos ni el tratamiento de correcciones.');for(const label of Object.values(criterionNames))paragraph(root,label);paragraph(root,'Resultados por criterio: prácticas respaldadas, resultados mixtos, problemas documentados o evidencia insuficiente. Se publican denominadores y limitaciones. La falta de observaciones no se convierte en una mala nota ni en una posición central.');paragraph(root,'Las correcciones generan revisiones nuevas. Los cortes asOf y knownAt permiten reconstruir qué era válido y qué se conocía. El método no asigna una probabilidad de verdad al medio ni confirma incidentes.');byId('records-more').hidden=true;byId('sources-status').textContent='Metodología disponible sin consultas a proveedores ni modelos.';
}else if(query.get('dossierId'))void dossier();else void refresh();
