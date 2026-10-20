import { AsyncLocalStorage } from "node:async_hooks";

// Internal workflow scope; never populated from HTTP/model content.
export const operationContext = new AsyncLocalStorage();
const shared=new WeakMap();
export function shareOperation(task) {
  const context=operationContext.getStore();
  if(context){
    const owner=shared.get(task);
    if(owner && owner!==context){owner.followers ||= new Set();owner.followers.add(context);}
    else if(!owner)shared.set(task,context);
  }
  return task;
}
export function checkOperation() { operationContext.getStore()?.signal.throwIfAborted(); }
export function committedOperationItems(count) {
  const context=operationContext.getStore();
  const visited=new Set();
  const notify=scope=>{if(!scope || visited.has(scope))return;visited.add(scope);scope.committed(count);for(const follower of scope.followers || [])notify(follower);};
  if(count>0)notify(context);
}
