// Viewport and explicit keyboard/panel interest share one lifecycle signal.
export function observeInterest(root,onChange) {
  let viewport=typeof IntersectionObserver==='undefined',focused=false,destroyed=false;
  const state={interested:false,destroy(){destroyed=true;observer?.disconnect();mutations?.disconnect();document.removeEventListener('visibilitychange',update);root?.removeEventListener('focusin',focus);root?.removeEventListener('focusout',blur);}};
  const update=()=>{
    const collapsed=root?.closest?.('details:not([open]),[hidden],.collapse:not(.show)');
    const interested=Boolean(root && !document.hidden && !collapsed && (viewport||focused));
    if(!destroyed && interested!==state.interested){state.interested=interested;onChange(interested);}
  };
  const focus=()=>{focused=true;update();},blur=()=>{focused=false;update();};
  const observer=typeof IntersectionObserver!=='undefined' && root ? new IntersectionObserver(entries=>{viewport=entries.some(entry=>entry.isIntersecting);update();}) : null;
  observer?.observe(root);
  const mutations=typeof MutationObserver!=='undefined' && root ? new MutationObserver(update) : null;
  for(let element=root;element&&element!==document.body;element=element.parentElement)mutations?.observe(element,{attributes:true,attributeFilter:['hidden','class','open','style']});
  document.addEventListener('visibilitychange',update);root?.addEventListener('focusin',focus);root?.addEventListener('focusout',blur);update();
  return state;
}
