import {createHash} from 'node:crypto';
import {splitObservationClocks,restoreObservationClocks} from './observationClocks.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const incomplete=()=>Object.assign(Error('Incomplete article observation'),{code:'STORAGE_NEWS_OBSERVATION_INCOMPLETE'});

// Return null for changes beyond observation clocks. Those continue through
// the existing complete-row path, including aliases and newly added metadata.
export function articleObservation(previousPayload,article){
 if(typeof article.archiveLastSeenAt!=='string'||!Number.isSafeInteger(article.revision)||article.revision<1)return null;
 const incoming=JSON.stringify(article),next=splitObservationClocks(incoming);
 if(splitObservationClocks(previousPayload).payload!==next.payload)return null;
 return {article_id:article.id,article_revision:article.revision,last_seen_at:article.archiveLastSeenAt,base_sha256:hash(previousPayload),clocks_json:JSON.stringify(next.clocks),record_sha256:hash(incoming)};
}

export function restoreArticleObservation(payload,observation){
 if(!observation)return JSON.parse(payload);
 try{
  const body=JSON.parse(payload);
  if(body.id!==observation.article_id||body.revision!==observation.article_revision||hash(payload)!==observation.base_sha256)throw incomplete();
  const restored=restoreObservationClocks(JSON.parse(splitObservationClocks(payload).payload),JSON.parse(observation.clocks_json));
  if(restored.archiveLastSeenAt!==observation.last_seen_at||hash(JSON.stringify(restored))!==observation.record_sha256)throw incomplete();
  return restored;
 }catch{throw incomplete();}
}
