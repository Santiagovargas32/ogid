// This path counts/sorts narrow index entries and hydrates only one response
// page. Text, identity and provenance matching still require the heavy scan.
const fields=new Set(['countries','from','to','timeField']);
export function compactNewsFilters(filters={}) {
  return Object.keys(filters).every(key=>fields.has(key)) &&
    (filters.countries===undefined || Array.isArray(filters.countries)&&filters.countries.length<=50&&filters.countries.every(value=>typeof value==='string'&&/^[A-Z]{2}$/.test(value))) &&
    ['publishedAt','receivedAt','updatedAt','archiveChangedAt'].includes(filters.timeField??'publishedAt') &&
    ['from','to'].every(key=>filters[key]===undefined || typeof filters[key]==='string'&&filters[key].length<=64&&Number.isFinite(Date.parse(filters[key])));
}
export function boundedNewsSearch(input) {
  if(input.service!=='news'||input.method!=='search'||!Array.isArray(input.args)||input.args.length!==1)return false;
  const query=input.args[0];
  if(!query||typeof query!=='object'||Array.isArray(query))return false;
  const {limit=20,maxBytes=262144,cursor,...filters}=query;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>524288)return false;
  // A validated cursor already owns bounded frozen references. It never scans
  // or counts the archive again, including cursors from complex searches.
  if(cursor!==undefined)return typeof cursor==='string'&&cursor.length>0&&cursor.length<=2048&&Object.keys(filters).length===0;
  return compactNewsFilters(filters);
}
