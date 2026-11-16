const VERSION='ogid-wire-schema-v1';
const escapePointer=value=>value.replace(/~/g,'~0').replace(/\//g,'~1');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const maps=['properties','patternProperties','$defs','definitions','dependentSchemas'];
const singles=['additionalProperties','additionalItems','contains','propertyNames','if','then','else','not','unevaluatedProperties','unevaluatedItems','contentSchema'];
const lists=['allOf','anyOf','oneOf','prefixItems'];

// Grammar generation expands bounded repetitions. The wire schema deliberately
// over-approximates those maxima; the original schema MUST still validate every
// generated candidate before publication. No canonical contract is changed.
export function compileWireSchema(canonical) {
  if(typeof canonical!=='boolean'&&!object(canonical))throw TypeError('A JSON Schema object or boolean is required');
  // JSON copying also detaches aliased subschemas so every removed path has its
  // own audit entry. Annotation and const/enum values are copied without walking.
  const schema=JSON.parse(JSON.stringify(canonical)),postValidationOnly=[];
  function children(node,path){
    const result=[];
    for(const keyword of maps)if(object(node[keyword]))for(const [key,child] of Object.entries(node[keyword]))result.push([child,`${path}/${keyword}/${escapePointer(key)}`,keyword]);
    for(const keyword of singles)result.push([node[keyword],`${path}/${keyword}`,keyword]);
    for(const keyword of lists)if(Array.isArray(node[keyword]))node[keyword].forEach((child,index)=>result.push([child,`${path}/${keyword}/${index}`,keyword]));
    // Draft-07 tuple items and schema dependencies coexist with newer keywords.
    if(Array.isArray(node.items))node.items.forEach((child,index)=>result.push([child,`${path}/items/${index}`,'items']));
    else result.push([node.items,`${path}/items`,'items']);
    if(object(node.dependencies))for(const [key,child] of Object.entries(node.dependencies))if(!Array.isArray(child))result.push([child,`${path}/dependencies/${escapePointer(key)}`,'dependencies']);
    return result;
  }
  // A definition can be referenced beneath a negation or predicate elsewhere.
  // Without reference-polarity analysis preserve a referenced schema in full.
  function hasReferences(node){
    return object(node)&&(['$ref','$dynamicRef','$recursiveRef'].some(key=>Object.hasOwn(node,key))||children(node,'').some(([child])=>hasReferences(child)));
  }
  function visit(node,path) {
    if(!object(node))return;
    for(const keyword of ['maxLength','maxItems']){
      if(!Object.hasOwn(node,keyword)||keyword==='maxItems'&&!(node[keyword]>0))continue;
      postValidationOnly.push({path:`${path}/${keyword}`,keyword,value:node[keyword]});
      delete node[keyword];
    }
    for(const [child,childPath,keyword] of children(node,path)){
      // Weakening a predicate, negation or exclusive choice can REMOVE valid
      // instances. Keep their entire subtrees, including repetition maxima.
      if(['not','if','oneOf'].includes(keyword)||keyword==='contains'&&Object.hasOwn(node,'maxContains'))continue;
      visit(child,childPath);
    }
  }
  if(!hasReferences(schema))visit(schema,'');
  return {schema,postValidationOnly,version:VERSION};
}
