let latest=null;
export function newerNews(current,candidate){
 if(!candidate)return current;
 if(!current)return candidate;
 const revision=Number(candidate.revision)-Number(current.revision);
 if(Number.isFinite(revision)&&revision!==0)return revision>0?candidate:current;
 const cut=Date.parse(candidate.projectionGeneratedAt||candidate.asOf)-Date.parse(current.projectionGeneratedAt||current.asOf);
 if(Number.isFinite(cut)&&cut!==0)return cut>0?candidate:current;
 return Date.parse(candidate.freshness?.evaluatedAt||candidate.asOf)<Date.parse(current.freshness?.evaluatedAt||current.asOf)?current:candidate;
}
export function renderNewsQuality(target,candidate){
 latest=newerNews(latest,candidate);if(!target||!latest)return;
 const c=latest,f=c.freshness||{},policy=c.freshnessPolicy||f.policy;
 const age=n=>Number.isFinite(n)?`${Math.floor(n/60000)} min ${Math.floor(n/1000)%60} s`:'desconocida';
 const at=v=>v?new Date(v).toLocaleString():'desconocida';
 const lines=[`Contenido geopolítico: ${c.sourceMode||'desconocido'}`,`Captura: ${f.acquisitionStatus||'desconocida'} · antigüedad ${age(f.acquisitionAgeMs)} · umbral ${policy?.acquisitionMs?policy.acquisitionMs/60000+' min':'histórico/desconocido'}`,
  `Publicación: ${at(c.latestGeopoliticalPublishedAt)} · antigüedad ${age(f.publicationAgeMs)} · umbral ${policy?.publicationMs?policy.publicationMs/60000+' min':'histórico/desconocido'}`,
  `Comprobación: ${at(c.lastSuccessfulCheckAt)} · Proyección: ${at(c.projectionGeneratedAt||c.asOf)}`,
  `Evaluación: ${at(f.evaluatedAt)} · revisión ${c.revision??'desconocida'} · ${policy?.version||'política histórica'}`,
  (c.staleReasons||[]).join(' · ')||'Contenido dentro de su ventana de frescura'];
 target.replaceChildren();for(const [i,line]of lines.entries()){const p=document.createElement(i?'p':'strong');p.textContent=line;target.append(p);}
}
