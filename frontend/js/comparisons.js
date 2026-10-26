import {request} from './api.js';
const byId=id=>document.getElementById(id);
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
const paragraph=(parent,text)=>parent.append(node('p',text));
const query=new URLSearchParams(location.search),groupId=query.get('groupId'),articleId=query.get('articleId');
const modality={reported:'relato atribuido',negated:'negación',prospective:'futuro o amenaza',opinion:'opinión',mixed:'modalidad mixta',unknown:'modalidad desconocida'};
let cursor=null,filters={},busy=false;
function link(label,href,external=false){const a=node('a',label);try{const url=new URL(href,location.origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return node('span',label);a.href=url.href;if(external){a.target='_blank';a.rel='noopener noreferrer';}}catch{return node('span',label);}return a;}
function groupCard(group){
  const card=node('article');card.append(node('h3',group.title||'Publicación sin título'));
  const s=group.summary;paragraph(card,`${s.publications} publicaciones · ${s.publishers} editores resueltos · ${s.knownOriginChains} cadenas de origen conocidas · ${s.unknownOrigins} orígenes desconocidos.`);
  paragraph(card,`${group.eventType||'Tipo pendiente'} · ${(group.locations||[]).map(x=>x.id).join(', ')||'lugar pendiente'} · ${group.anchorAt}. Estado: ${group.status}.`);
  card.append(link('Comparar esta cobertura',`/comparisons.html?${new URLSearchParams({groupId:group.redirectGroupId||group.groupId})}`));return card;
}
async function loadLinks(claim,root,button,next){
  button.disabled=true;
  try{
    const data=await request(`/api/news/claims/${encodeURIComponent(claim.claimId)}`,{limit:10,maxBytes:32768,...(next?{cursor:next}:{})});
    if(!next)paragraph(root,`Revisión ${claim.articleRevision}: ${data.current?'vigente en esta lectura':'histórica; existe una revisión posterior'}.`);
    if(!data.items.length)paragraph(root,'Sin relaciones revisadas registradas.');
    for(const item of data.items){const block=node('div');paragraph(block,`${({support:'apoyo',contradiction:'contradicción',context:'contexto'})[item.relation]} · ${item.reviewer}: ${item.reason}${item.current?'':' · relación histórica: alguna afirmación tiene una revisión posterior'}`);const other=item.leftClaimId===claim.claimId?item.rightClaimId:item.leftClaimId;paragraph(block,`Afirmación relacionada: ${other}`);for(const ref of item.references)block.append(link('Referencia de la revisión',ref,true));root.append(block);}
    if(data.hasMore){button.textContent='Más relaciones revisadas';button.onclick=()=>void loadLinks(claim,root,button,data.nextCursor);button.disabled=false;}else button.hidden=true;
  }catch{paragraph(root,'No se pudieron cargar las relaciones; puedes reintentar.');button.disabled=false;}
}
function publicationCard(item){
  const card=node('article');card.append(node('h3',item.title));
  paragraph(card,`Editor: ${item.publisherId||'pendiente de resolver'} · Origen: ${item.originChainId||'desconocido'}${item.originReviewId?` (revisión ${item.originReviewId})`:''}.`);
  paragraph(card,`${item.publishedAt||'Publicación sin fecha; recepción: '+item.receivedAt} · Idioma: ${item.language||'desconocido'} · ${item.classificationStatus} · ${item.textScope}.`);
  if(item.url)card.append(link('Abrir publicación original',item.url,true));
  for(const claim of item.claims){const block=node('section');block.append(node('h4',modality[claim.modality]||claim.modality),node('blockquote',claim.text));paragraph(block,`Afirmación atribuida al editor de esta publicación · revisión ${claim.articleRevision} · ${claim.textScope} · ${claim.claimId}`);const button=node('button','Consultar relaciones revisadas');button.type='button';const relations=node('div');button.onclick=()=>void loadLinks(claim,relations,button);block.append(button,relations);card.append(block);}
  return card;
}
async function load(reset=false){
  if(busy)return;const moreHadFocus=document.activeElement===byId('comparison-more');busy=true;byId('comparison-more').disabled=true;byId('comparison-refresh').disabled=true;
  if(reset){cursor=null;const to=new Date(),from=new Date(to-Number(byId('comparison-window').value)*3600000);filters=articleId?{articleId}:{from:from.toISOString(),to:to.toISOString()};}
  try{
    const data=await request(groupId?`/api/news/comparisons/${encodeURIComponent(groupId)}`:'/api/news/comparisons',{...(groupId?{}:filters),...(cursor?{cursor}:{}),limit:10,maxBytes:65536});
    if(reset){byId('comparison-items').replaceChildren();byId('comparison-summary').replaceChildren();}
    if(data.group){
      const root=byId('comparison-summary');root.replaceChildren(groupCard(data.group));
      if(data.group.lastReview){const r=data.group.lastReview;paragraph(root,`Revisión: ${r.reviewer} · ${r.reason}`);for(const ref of r.references)root.append(link('Evidencia de revisión',ref,true));}
      if(data.group.redirectGroupId)root.append(link('Continuar en la cobertura unida',`/comparisons.html?${new URLSearchParams({groupId:data.group.redirectGroupId})}`));
      const hints=data.relationHints?.items||[];
      paragraph(root,`En esta página: ${hints.filter(x=>x.relation==='possible-contradiction').length} posibles discrepancias de modalidad y ${hints.filter(x=>x.relation==='compatible-reports').length} coincidencias de contexto${data.relationHints?.partial?' (pistas parciales)':''}. No equivalen a verificación de las afirmaciones.`);
    }
    let firstNew=null;
    for(const item of data.items){const card=data.group?publicationCard(item):groupCard(item);firstNew||=card;byId('comparison-items').append(card);}
    cursor=data.nextCursor;byId('comparison-more').hidden=!data.hasMore;
    if(moreHadFocus&&!data.hasMore&&firstNew){firstNew.tabIndex=-1;firstNew.focus({preventScroll:true});}
    byId('comparison-more').textContent=groupId?'Cargar más publicaciones':'Cargar más agrupaciones';
    byId('comparison-status').textContent=data.available===false?'Comparación no disponible en este almacenamiento.':!data.items.length?'Sin publicaciones indexadas en esta selección. El enriquecimiento histórico es gradual; esto no demuestra ausencia de noticias.':`Lectura fijada en revisión ${data.asOfSequence}. Los orígenes desconocidos conservan su incertidumbre. Las relaciones candidatas sólo cubren cada página devuelta.`;
  }catch{byId('comparison-status').textContent='No se pudo cargar la comparación. Reintenta la lectura.';}
  finally{busy=false;byId('comparison-more').disabled=false;byId('comparison-refresh').disabled=false;}
}
byId('comparison-more').onclick=()=>void load();
byId('comparison-refresh').onclick=()=>void load(true);
byId('comparison-window').onchange=()=>void load(true);
if(groupId||articleId)byId('comparison-window').disabled=true;
void load(true);
