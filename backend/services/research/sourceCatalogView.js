import { AWARENESS_SOURCES, AWARENESS_SOURCE_CATALOG_VERSION } from "../awareness/awarenessCatalog.js";

export async function researchSourceCatalog({officialSourceService,awarenessService}) {
  const specific=await officialSourceService.status();
  const publicSnapshot=awarenessService?.getSnapshot({}, {publicView:true});
  const statuses=new Map((publicSnapshot?.sourceStatus||[]).map(s=>[s.sourceId,s]));
  const awareness=AWARENESS_SOURCES.map(s=>({sourceId:s.sourceId,name:s.name,url:s.url,adapter:s.adapter,kind:s.kind,enabled:s.enabled,admission:s.admissionState,managedBy:"awareness",runtime:{status:statuses.get(s.sourceId)?.status||"unknown",lastSuccessAt:statuses.get(s.sourceId)?.lastSuccessAt||null}}));
  return {...specific,catalogVersion:AWARENESS_SOURCE_CATALOG_VERSION,catalog:[...specific.sources.map(s=>({...s,managedBy:"research-sources"})),...awareness],
    warnings:[...specific.warnings,"sources lists dedicated configured adapters; catalog also includes Awareness sources, whose ingestion is managed by Awareness. Catalog admission does not certify a successful live read."]};
}
