import { api } from "./api.js";

const el=id=>document.getElementById(id);
const escape=value=>String(value??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const requestId=()=>`admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let instruments=[],previewInput=null,replaySnapshot=null,busy=false;
const message=text=>{el("history-message").textContent=text;};
function range() {
  const startAt=`${el("history-start").value}T00:00:00.000Z`;
  const endAt=new Date(Math.min(Date.parse(`${el("history-end").value}T23:59:59.999Z`),Date.now())).toISOString();
  return {startAt,endAt};
}
function invalidate(){previewInput=null;el("history-import-save").disabled=true;}
async function refresh() {
  const data=await api.getAdminHistory();instruments=data.instruments;
  const selected=el("history-instrument").value;
  el("history-instrument").innerHTML=instruments.map(i=>`<option value="${escape(i.instrumentId)}">${escape(i.symbol)} (${escape(i.currency)})</option>`).join("");
  if(instruments.some(i=>i.instrumentId===selected))el("history-instrument").value=selected;
  el("history-coverage").innerHTML=`<table class="table table-dark table-sm"><thead><tr><th>Instrumento</th><th>Velas diarias guardadas</th><th>Primera apertura / último cierre</th><th>Identidad pendiente</th></tr></thead><tbody>${instruments.map(i=>`<tr><td>${escape(i.symbol)}</td><td>${i.coverage.validBars} / 500</td><td>${escape(i.coverage.oldest)} / ${escape(i.coverage.newest)}</td><td>${escape(i.missingIdentity.join(", "))}</td></tr>`).join("")}</tbody></table>`;
  el("history-jobs").innerHTML=data.jobs.map(j=>`<div class="mb-2"><strong>${escape(j.jobId)}</strong>: ${escape(j.status)}, ventanas ${j.cursor}/${j.chunks.length}; objetivo ${j.coverage.every(c=>c.goalMet)?"cubierto":"pendiente"}. ${["completed","blocked"].includes(j.status)?"":`<button class="btn btn-sm btn-outline-info" data-history-job="${escape(j.jobId)}">Ejecutar hasta 4 peticiones</button>`}</div>`).join("");
  el("history-datasets").innerHTML=data.datasets.map(d=>`<div class="mb-2">CSV ${escape(d.source)} · ${escape(d.providerSymbol)} · ${escape(d.adjustmentMode)} <button class="btn btn-sm btn-outline-info" data-history-dataset="${escape(d.datasetId)}" data-instrument="${escape(d.instrumentId)}" data-adjustment="${escape(d.adjustmentMode)}">Consultar técnica diaria</button></div>`).join("");
  el("history-data-gaps").textContent=`Fuentes en catálogo: ${data.researchSources.catalog.length}; adaptadores específicos configurados: ${data.researchSources.sources.length}. Admisión no acredita lectura real. Eventos legacy pendientes de relectura (hasta 100): ${data.eventIdentity.legacyRequiresReplay.length}. No se usan para impactos. Holdings y evaluación requieren evidencia fechada y muestras prospectivas.`;
}
async function action(work) {
  if(busy)return;busy=true;
  const buttons=[...el("history-title").closest("section").querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);
  try{await work();await refresh();}catch(error){message(error.message);}finally{busy=false;buttons.filter(b=>!["history-import-save","events-replay-save"].includes(b.id)).forEach(b=>b.disabled=false);el("history-import-save").disabled=!previewInput;el("events-replay-save").disabled=!replaySnapshot;}
}
export async function initAdminHistory() {
  if(!el("history-form"))return;
  const now=new Date();el("history-end").value=now.toISOString().slice(0,10);el("history-end").max=el("history-end").value;
  el("history-refresh").addEventListener("click",()=>action(async()=>{message("Cobertura actualizada desde los datos guardados.");}));
  el("history-start").value=new Date(now.getTime()-860*86400000).toISOString().slice(0,10);
  el("history-form").addEventListener("input",invalidate);el("history-import-form").addEventListener("input",invalidate);
  el("history-form").addEventListener("submit",event=>{event.preventDefault();action(async()=>{
    const job=await api.createHistoryJob({requestId:requestId(),instrumentIds:[el("history-instrument").value],targetBars:Number(el("history-target").value),...range()});
    message(`Preparada: ${job.estimatedRequests} peticiones como máximo, más reintentos limitados. Pulsa ejecutar para descargar.`);
  });});
  el("history-import-form").addEventListener("submit",event=>{event.preventDefault();action(async()=>{
    invalidate();const file=el("history-csv").files[0];if(!file||file.size>500000)throw new Error("Selecciona un CSV de hasta 500 kB.");
    const instrument=instruments.find(i=>i.instrumentId===el("history-instrument").value);if(!instrument)throw new Error("Selecciona un instrumento.");
    const input={requestId:requestId(),instrumentId:instrument.instrumentId,currency:instrument.currency,source:el("history-source").value,sourceUrl:el("history-source-url").value,providerSymbol:el("history-provider-symbol").value,adjustmentMode:el("history-adjustment").value,...range(),csv:await file.text()};
    const preview=await api.importHistory({...input,dryRun:true});previewInput=input;el("history-preview").textContent=JSON.stringify(preview,null,2);message("CSV validado; revisa cobertura, huecos y procedencia antes de guardar.");
  });});
  el("history-import-save").addEventListener("click",()=>action(async()=>{
    if(!previewInput)return;const result=await api.importHistory({...previewInput,dryRun:false});invalidate();el("history-preview").textContent=JSON.stringify(result,null,2);message("CSV guardado en su serie independiente.");
  }));
  el("history-jobs").addEventListener("click",event=>{const button=event.target.closest("[data-history-job]");if(button)action(async()=>{
    const job=await api.runHistoryJob({jobId:button.dataset.historyJob,maxRequests:4});message(`${job.status}: ${job.requestsThisRun} peticiones ejecutadas. Cobertura ${job.coverage.map(c=>c.validBars).join(", ")} velas diarias en rango.`);
  });});
  el("history-datasets").addEventListener("click",event=>{const button=event.target.closest("[data-history-dataset]");if(button)action(async()=>{
    const ctx=await api.getTechnicalContext({datasetId:button.dataset.historyDataset,instrumentId:button.dataset.instrument,adjusted:button.dataset.adjustment,limit:500});
    el("history-preview").textContent=JSON.stringify({datasetId:ctx.datasetId,sampleSize:ctx.sampleSize,lastClosedCandleAt:ctx.lastClosedCandleAt,sma200:ctx.indicators.sma200,quality:ctx.quality,coverage:ctx.coverage},null,2);message("Técnica sobre la serie importada; no activa alertas.");
  });});
  el("events-replay-preview").addEventListener("click",()=>action(async()=>{
    replaySnapshot=null;const result=await api.replayAdminEvents({dryRun:true});replaySnapshot=result.snapshotId;el("history-preview").textContent=JSON.stringify(result,null,2);message(`Relectura prevista: ${result.count} eventos admitidos, sin llamadas externas. Se conservan los registros antiguos.`);
  }));
  el("events-replay-save").addEventListener("click",()=>action(async()=>{
    if(!replaySnapshot)return;const snapshotId=replaySnapshot;replaySnapshot=null;const result=await api.replayAdminEvents({dryRun:false,snapshotId});el("history-preview").textContent=JSON.stringify(result,null,2);message("Agenda almacenada releída con identidades nuevas; consultar cobertura legacy pendiente.");
  }));
  await refresh();
}
