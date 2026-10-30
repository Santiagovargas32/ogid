const ratings = ['left','center-left','center','center-right','right'];
const labels = {'left':'izquierda','center-left':'centroizquierda','center':'centro','center-right':'centroderecha','right':'derecha'};
const states = {unrated:'sin evaluar','not-applicable':'no aplicable',unmapped:'escala sin equivalencia',disputed:'evaluaciones en desacuerdo','different-contexts':'contextos políticos distintos',partial:'evaluaciones parciales',unresolved:'editor pendiente',loading:'consultando',unavailable:'no disponible'};

export function sourceAssessmentLabel(view={status:'loading'}) {
  if(!view.ownEvaluation&&view.ownEvaluationStatus){const label={'pending-review':'elaborada, pendiente de revisión',reject:'propuesta rechazada','changes-requested':'propuesta pendiente de corrección',withdraw:'evaluación retirada'}[view.ownEvaluationStatus]||'pendiente de publicación';return {label,position:-1,text:`Evaluación del medio: ${label}`,href:`/sources.html?${new URLSearchParams({publisherId:view.publisherId||'',edition:view.edition||''})}`};}
  if(view.ownEvaluation){const e=view.ownEvaluation,p=e.political,position=p.status==='supported'?ratings.indexOf(p.rating):-1;const label=position>=0?labels[p.rating]:({'insufficient-evidence':'evaluada: evidencia insuficiente',mixed:'evaluación mixta','not-applicable':'evaluada: eje no aplicable',supported:'posición contextual documentada'}[p.status]||'evaluación propia');return {label,position,text:`Tendencia del medio: ${label} · ${p.scope}`,href:`/sources.html?${new URLSearchParams({dossierId:e.dossierId,revision:e.revision})}`};}
  const position=view.status==='rated'?ratings.indexOf(view.rating):-1;
  const label=position>=0?labels[view.rating]:states[view.status]||'sin posición común';
  const contexts=[...new Set((view.evaluations||[]).map(e=>e.politicalScope))];
  return {label,position,text:`Tendencia del medio: ${label}${contexts.length?` · ${contexts.join(', ')}`:''}`,href:`/sources.html${view.publisherId?`?${new URLSearchParams({publisherId:view.publisherId,...(view.edition?{edition:view.edition}:{})})}`:''}`};
}

// Keep the anchor and scale nodes: metadata refreshes must preserve keyboard focus.
export function paintSourceAssessment(link,view) {
  const model=sourceAssessmentLabel(view);
  link.href=model.href;link.title=model.text;link.setAttribute('aria-label',`${model.text}. Ver procedencia y cobertura`);
  link.querySelector('.source-rating-label').textContent=model.text;
  const marker=link.querySelector('.source-rating-marker');marker.hidden=model.position<0;
  marker.style.setProperty('--rating-position',Math.max(0,model.position));
}

export class SourceAssessmentCache {
  constructor(read,{now=Date.now,onChange=()=>{},ttl=60000}={}) {Object.assign(this,{read,now,onChange,ttl});this.items=[];this.freshAt=-Infinity;this.retryAt=0;this.task=null;this.failed=false;}
  lookup(article) {
    if(article.publisherResolution?.status!=='resolved'||!article.publisherId)return {status:'unresolved'};
    const domain=article.publisherResolution.domain;
    const item=this.items.find(row=>row.publisherId===article.publisherId&&(domain===row.edition||domain?.endsWith(`.${row.edition}`)));
    if(this.failed)return {publisherId:article.publisherId,status:'unavailable'};
    return item||{publisherId:article.publisherId,status:Number.isFinite(this.freshAt)?'unavailable':'loading'};
  }
  refresh({interested=true,signal}={}) {
    if(!interested||this.now()-this.freshAt<this.ttl||this.now()<this.retryAt)return Promise.resolve();
    if(this.task)return this.task;
    this.task=(async()=>{
      const items=[];let cursor;
      do {const page=await this.read({cursor,limit:20,maxBytes:65536},{signal});items.push(...page.items.map(row=>page.available===false?{...row,status:'unavailable'}:row));cursor=page.nextCursor;if(page.hasMore&&!cursor)throw Error('Missing source assessment cursor');}while(cursor);
      this.items=items;this.freshAt=this.now();this.failed=false;this.onChange();
    })().catch(()=>{if(!signal?.aborted){this.failed=true;this.retryAt=this.now()+15000;this.onChange();}}).finally(()=>{this.task=null;});
    return this.task;
  }
}
