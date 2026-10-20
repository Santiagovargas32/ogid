import { readyModel } from "./config.js";
import { setTimeout as wait } from "node:timers/promises";

// Preparation may be deferred; activation must attest the actual resident.
export async function ensureShadowModel({ manifest, upstream, apiKey, load = false, defer = false, releaseIdleAlias = null, fetchImpl = fetch, waitImpl = wait }) {
  const selected = manifest.models?.find(m => `llamacpp/${m.alias}` === manifest.defaultModel);
  if (manifest.schemaVersion !== "ogid-model-catalog-v1" || !readyModel(selected)) throw Error("Catálogo sin modelo predeterminado comprobado.");
  const base = new URL(upstream);
  if (!["http:","https:"].includes(base.protocol) || !["127.0.0.1","localhost","[::1]"].includes(base.hostname) || base.username || base.password || !apiKey) throw Error("Router local y credencial requeridos.");
  const request = async (path,body) => {
    const r = await fetchImpl(new URL(path,base), { method: body ? "POST":"GET", headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"}, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(body ? 360000:10000),redirect:"error" });
    if(!r.ok)throw Object.assign(Error(`Router no disponible: HTTP ${r.status}`),{status:r.status});
    return r.json();
  };
  let inventory = await request("/models");
  if(!inventory.data?.some(m=>m.id===selected.alias))throw Error("Alias verificado ausente del router.");
  const residentState=()=>inventory.data.find(m=>m.id===selected.alias)?.status?.value;
  const awaitLoading=async()=>{
    const deadline=Date.now()+360000;
    while(residentState()==="loading" && Date.now()<deadline){await waitImpl(1000);inventory=await request("/models");}
    if(residentState()!=="loaded")throw Error("El modelo no confirmó la carga; revisar llama.cpp sin reenviar automáticamente la petición.");
  };
  if(residentState()==="loading" && !defer)await awaitLoading();
  if(residentState()!=="loaded") {
    if(defer)return {alias:selected.alias,ready:false,state:"waiting-model",loadedOther:inventory.data.filter(m=>m.status?.value!=="unloaded").map(m=>m.id)};
    if(!load)throw Error("Modelo no residente; añadir --load-verified-model después de liberar el modelo actual.");
    if(releaseIdleAlias && inventory.data.some(m=>m.status?.value!=="unloaded")) {
      const active=inventory.data.filter(m=>m.status?.value!=="unloaded");
      if(!/^[A-Za-z0-9._:-]{1,160}$/.test(releaseIdleAlias) || active.length!==1 || active[0].id!==releaseIdleAlias || active[0].status?.value!=="loaded")throw Error("El modelo activo no coincide con el alias que autorizaste liberar.");
      for(let check=0;check<2;check++) {
        const slots=await request(`/slots?model=${encodeURIComponent(releaseIdleAlias)}&autoload=false`);
        if(!Array.isArray(slots) || !slots.length || slots.some(s=>s.is_processing!==false))throw Error("El modelo actual está ocupado o no se puede comprobar; se conserva sin cambios.");
        if(!check)await waitImpl(2000);
      }
      if((await request("/models/unload",{model:releaseIdleAlias})).success!==true)throw Error("Descarga no confirmada; no cargar otro modelo.");
      inventory=await request("/models");
      // Router acknowledges unload before its child has necessarily exited.
      // Poll that same transition, never resend the mutation or evict a new model.
      for(let poll=0;poll<60 && inventory.data.some(m=>m.id===releaseIdleAlias && m.status?.value==="unloading");poll++) {
        await waitImpl(500);inventory=await request("/models");
      }
    }
    if(inventory.data.some(m=>m.status?.value!=="unloaded"))throw Error("Otro modelo sigue cargado o en transición. Liberarlo desde su cliente antes de continuar; no se interrumpe ni descarga automáticamente.");
    try {
      if((await request("/models/load",{model:selected.alias})).success!==true)throw Error("Carga no confirmada; revisar llama.cpp.");
    } catch(error) {
      // A lost/failed response can accompany an accepted load. Reconcile only;
      // never blindly resend a potentially admitted model-loading request.
      inventory=await request("/models");
      if(!["loading","loaded"].includes(residentState()))throw error;
      await awaitLoading();
    }
    inventory=await request("/models");
    if(residentState()==="loading")await awaitLoading();
    if(residentState()!=="loaded")throw Error("El router no confirmó el modelo residente.");
  }
  const props = await request(`/props?model=${encodeURIComponent(selected.alias)}&autoload=false`);
  if(props.total_slots!==1 || props.default_generation_settings?.n_ctx!==selected.context)throw Error("Contexto/slots distintos a los comprobados; no activar shadow.");
  return {alias:selected.alias,ready:true,state:"ready",context:selected.context,slots:1};
}
