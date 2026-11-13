// Indexed point reads and existing paged domain readers have their own row /
// wire budgets. They must retain pressure admission without waiting for an
// unrelated whole-corpus calculation. This does not admit unbounded searches.
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);
const fields={detail:new Set(['id','atSequence','cursor','limit','maxBytes']),revisions:new Set(['id','cursor','limit','maxBytes']),changes:new Set(['sinceSequence','cursor','limit','maxBytes'])};
export function boundedDomainPage(input) {
  if(!Array.isArray(input.args)||input.args.length!==1)return false;
  if(input.service==='news'&&input.method==='getItem')return identifier(input.args[0]);
  if(input.service!=='situations'||!Object.hasOwn(fields,input.method))return false;
  const query=input.args[0];
  if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!fields[input.method].has(key)))return false;
  const {limit=50,maxBytes=65536,cursor,atSequence,sinceSequence}=query;
  return (input.method==='changes'||identifier(query.id))&&
    Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(maxBytes)&&maxBytes>=4096&&maxBytes<=262144&&
    (cursor===undefined||typeof cursor==='string'&&cursor.length>0&&cursor.length<=4096)&&
    [atSequence,sinceSequence].every(value=>value===undefined||Number.isSafeInteger(value)&&value>=0);
}
