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
  for(const [label,value] of [['Publicaciones',s.articles],['Editores resueltos',s.publishers],['Artículos con editor desconocido',s.unknownPublisherArticles],['Grupos propietarios conocidos',s.ownerGroups],['Artículos con propietario desconocido',s.unknownOwnerArticles],['Identificadores de cadena de origen',s.knownOriginChains],['Artículos con origen desconocido',s.unknownOriginArticles],['Artículos sin país editorial conocido',s.unknownEditorialCountryArticles]])dl.append(node('dt',label),node('dd',String(value)));
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
void refresh();
