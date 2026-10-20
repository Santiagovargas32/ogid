import {fillAgentModels} from "./agentModels.js";
import {renderAgentOperations} from "./agentOperationsView.js";
export function mountAgentAdmin() {
  const target = document.getElementById("agent-admin-body");
  if (!target) return;
  let stopped = false,pending=false,dirty=false,models,refreshing=false;
  const controller=new AbortController();
  const controls=document.createElement("div");controls.className="diagnostic-list p-3";
  const label=document.createElement("label");label.htmlFor="agent-background-model";label.textContent="Modelo del analista de fondo";
  const select=document.createElement("select");select.id="agent-background-model";select.className="form-select form-select-sm";select.disabled=true;
  const apply=document.createElement("button");apply.type="button";apply.textContent="Aplicar modelo";apply.className="btn btn-sm btn-outline-info";apply.disabled=true;
  const reload=document.createElement("button");reload.type="button";reload.textContent="Actualizar modelos";reload.className="btn btn-sm btn-outline-info";
  const message=document.createElement("p");message.setAttribute("role","status");
  const hint=document.createElement("p");hint.textContent="La selección se guarda. Las generaciones ya iniciadas conservan su modelo. Seleccionar un modelo disponible solicita su carga y comprobación. El modelo de fondo cambia sólo si la prueba pasa; una inferencia activa conserva su turno.";
  controls.append(label,select,apply,reload,message,hint);target.before(controls);
  async function request(path,options={}){
    const r=await fetch(path,{credentials:"same-origin",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),...options,headers:{"Content-Type":"application/json"}});const value=await r.json();
    if(!r.ok)throw Error(value.error?.code || `HTTP ${r.status}`);return value.data;
  }
  async function loadModels(){
    if(pending)return;
    reload.disabled=true;
    try{
      models=await request("/api/agent/v1/models");if(stopped)return;
      fillAgentModels(select,models,dirty?select.value:models.backgroundModel);
      apply.disabled=select.disabled || !models.models.some(m=>m.id===select.value && (m.ready||m.selectable));
      if(models.activation?.state==='uncertain')message.textContent='La confirmación de selección se perdió. Revisar la selección durable antes de reintentar.';
      else if(models.activation?.state==='failed')message.textContent=`No se pudo activar ${models.activation.model}: ${models.activation.errorCode}. El modelo anterior se conserva.`;
      else if(models.activation?.state==='queued')message.textContent=`Cargando y comprobando ${models.activation.model}; se espera a las inferencias admitidas.`;
      else message.textContent=models.state==="ready"?"Catálogo actualizado desde OpenCode.":"OpenCode no está disponible; vuelve a actualizar cuando esté iniciado.";
    }catch{message.textContent="No se pudo consultar el catálogo de OpenCode.";}
    finally{reload.disabled=false;}
  }
  select.onchange=()=>{dirty=true;apply.disabled=!models?.models.some(m=>m.id===select.value && (m.ready||m.selectable));};
  reload.onclick=()=>void loadModels();
  apply.onclick=async()=>{
    pending=true;apply.disabled=true;select.disabled=true;reload.disabled=true;message.textContent="Guardando selección…";
    try{
      const result=await request("/api/admin/agent/model",{method:"POST",body:JSON.stringify({model:select.value})});
      dirty=false;if(result.pending){message.textContent=`Carga solicitada: ${result.model}. Consulta el progreso al actualizar modelos.`;return;}message.textContent=`Modelo seleccionado: ${result.backgroundModel}. Se aplicará a las siguientes tareas.`;
      await refresh();
    }catch{message.textContent="No se pudo cambiar el modelo. Actualiza el catálogo y comprueba que el modelo esté validado y disponible.";}
    finally{pending=false;select.disabled=false;reload.disabled=false;apply.disabled=false;}
  };
  async function refresh() {
    if(stopped || refreshing)return;
    refreshing=true;
    try {
      const r = await fetch("/api/admin/agent", { credentials: "same-origin",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { data } = await r.json();
      if (stopped) return;
      target.replaceChildren();
      renderAgentOperations(data,{process:document.getElementById('agent-process-body'),activity:document.getElementById('agent-activity-body'),publications:document.getElementById('agent-publications-body'),updated:document.getElementById('agent-activity-updated')});
      for (const [label, value] of [
        ["Modo", data.mode],
        ["Modelo de fondo", data.backgroundModel || "sin verificar"],
        ["Última publicación", data.latest?.publishedAt || "ninguna"],
        ["Contexto", data.contextPolicy],
        ["Cuota local", "sin cuota"],
        ["Acumulados históricos", data.jobs.map((j) => `${j.status}: ${j.count}`).join(" · ")],
        ["Prerequisitos", data.worker?.state || "desactivado"],
        ["OpenCode / MCP", data.workerHealth?.state || "sin telemetría"],
      ]) {
        const p = document.createElement("p");
        p.textContent = `${label}: ${value}`;
        target.append(p);
      }
      if(!pending && !dirty && models && select.value!==data.backgroundModel)select.value=data.backgroundModel;
      if(data.modelSelectionWarning){const p=document.createElement("p");p.textContent="El modelo guardado necesita validación; se está usando el modelo inicial.";target.append(p);}
      const button = document.createElement("button");
      button.textContent = data.paused
        ? "Reanudar analista"
        : "Pausar analista";
      button.type = "button";
      button.className = "btn btn-sm btn-outline-info";
      button.onclick = async () => {
        await fetch("/api/admin/agent/pause", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused: !data.paused }),
        });
        await refresh();
      };
      target.append(button);
      for (const device of data.devices || []) {
        const row = document.createElement("p");
        row.textContent = `Dispositivo: ${device.label} · ${device.revokedAt ? "revocado" : "autorizado"}`;
        if (!device.revokedAt) {
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.textContent = "Revocar";
          revoke.onclick = async () => {
            const r = await fetch(
              `/api/admin/agent/devices/${encodeURIComponent(device.deviceId)}/revoke`,
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              },
            );
            if (r.ok) await refresh();
          };
          row.append(revoke);
        }
        target.append(row);
      }
    } catch (e) {
      const p = document.createElement("p");
      p.textContent = `Diagnóstico no disponible: ${e.message}`;
      target.append(p);
    } finally {
      refreshing=false;
    }
  }
  void refresh();void loadModels();
  const timer = setInterval(()=>{void refresh();if(models?.activation?.state==='queued')void loadModels();}, 5000);
  window.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    },
    { once: true },
  );
}
