const reasons={AGENT_MODEL_UNVERIFIED:"pendiente de validar",AGENT_MODEL_PROBE_FAILED:"prueba no superada",AGENT_MODEL_NOT_IN_OPENCODE:"no disponible en OpenCode",AGENT_MODEL_CAPABILITIES_CHANGED:"contexto o herramientas sin validar",AGENT_OPENCODE_CATALOG_UNAVAILABLE:"OpenCode no disponible",AGENT_DISABLED:"analista desactivado"};
const probeErrors={MODEL_LOAD_FAILED:"el router no completó la carga",ABORT_ERR:"la prueba agotó su tiempo",AGENT_NO_PROGRESS:"las consultas de herramientas no progresaron",AGENT_INVALID_PUBLICATION:"la propuesta no superó la validación"};
export function fillAgentModels(select,catalog,preferred){
  select.replaceChildren();
  for(const model of catalog.models || []){
    const option=document.createElement("option");option.value=model.id;
    option.textContent=`${model.name || model.alias} · ${model.context || "?"} tokens${model.ready?"":` · ${reasons[model.reason] || "no disponible"}`}`;
    if(model.resident)option.textContent+=" · cargado";else if(model.selectable)option.textContent+=" · cargar y comprobar";
    if(model.validation?.errorCode)option.title=`Última prueba: ${probeErrors[model.validation.errorCode] || model.validation.errorCode}${model.validation.at?` · ${model.validation.at}`:''}`;
    option.disabled=!(model.ready||model.selectable);select.append(option);
  }
  const fallback=(catalog.models || []).find(m=>m.id===catalog.backgroundModel && m.ready) || (catalog.models || []).find(m=>m.ready||m.selectable);
  select.value=[...select.options].some(o=>o.value===preferred)?preferred:fallback?.id || "";
  select.disabled=catalog.state!=="ready" || !(catalog.models || []).some(m=>m.ready||m.selectable);
}
