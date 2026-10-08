import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stableHash } from "../../utils/stableHash.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../../utils/error.js";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class MaterialAlertStore {
  constructor({ persistencePath = null, now = Date.now, retentionDays = 30, maxEntries = 10000 } = {}) {
    this.path = persistencePath; this.now = now; this.retentionDays = retentionDays; this.maxEntries = maxEntries; this.observed = new Map(); this.acknowledged = new Map();
    this.research = { scenarios:{}, signals:{}, consumers:{}, changes:[], sequence:0, retainedAfter:0, cursorKey:randomBytes(32).toString("base64url") };
    if (this.path) try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      if (!["material-alerts-v1","material-alerts-v2"].includes(value.schemaVersion)) throw new Error();
      this.observed = new Map(value.observed || []); this.acknowledged = new Map(value.acknowledged || []);
      if(value.research) { if(typeof value.research.cursorKey!=="string" || value.research.cursorKey.length<40 || !Array.isArray(value.research.changes) || !Number.isInteger(value.research.sequence) || value.research.sequence<0 || !Number.isInteger(value.research.retainedAfter) || value.research.retainedAfter<0 || value.research.retainedAfter>value.research.sequence || ["scenarios","signals","consumers"].some(k=>!value.research[k] || Array.isArray(value.research[k]) || typeof value.research[k]!=="object"))throw new Error();this.research=value.research; }
    } catch (error) { if (error.code !== "ENOENT") throw new AppError("No se pudo recuperar el estado de alertas; no sobrescribirlo.", 503, "ALERT_RECOVERY_FAILED"); }
    this.prune();
  }
  prune() {
    const cutoff = this.now() - this.retentionDays * 86400000;
    while(this.research.changes.length && (this.research.changes[0].generatedAt < new Date(cutoff).toISOString() || this.research.changes.length > this.maxEntries)) {this.research.retainedAfter=this.research.changes.shift().sequence;}
    for (const map of [this.observed, this.acknowledged]) {
      for (const [id, row] of map) if (Date.parse(row.observedAt || row.deliveredAt) < cutoff) map.delete(id);
      while (map.size > this.maxEntries) map.delete(map.keys().next().value);
    }
  }
  persist() {
    this.prune();
    if(Buffer.byteLength(JSON.stringify(this.research))>33554432)throw new AppError("Journal excede 32 MiB; archivar explícitamente.",507,"RESEARCH_CAPACITY");
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: "material-alerts-v2", research:this.research, observed: [...this.observed], acknowledged: [...this.acknowledged] }), { mode: 0o600 }); renameSync(temporary, this.path);
  }
  candidates(evidence = []) {
    this.prune(); const unique = new Map();
    for (const item of evidence) {
      // El mismo titular reproducido por feeds no es un hecho nuevo ni otra corroboración.
      const evidenceId = item.eventId || item.id;
      const earlierVersion = [...this.observed.values()].find(row => row.evidenceIds.includes(evidenceId));
      const factKey = earlierVersion?.factKey || hash([String(item.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), (item.publishedAt || item.scheduledAt || item.receivedAt || "").slice(0, 10)]);
      const semanticRevision = hash([item.title, item.summary || item.excerpt || null, item.status || null, item.importance || null]);
      const candidateId = `alert-${hash([factKey, semanticRevision]).slice(0, 40)}`;
      const earlier = unique.get(factKey);
      if (earlier) { earlier.evidenceIds.push(item.eventId || item.id); continue; }
      const acknowledged = this.acknowledged.get(factKey);
      const row = { candidateId, factKey, semanticRevision, title: item.title, evidenceIds: [...new Set([...(this.observed.get(candidateId)?.evidenceIds || []), evidenceId])].slice(0, 100), sourceRevision: item.revision ?? null,
        status: item.status || null, observedAt: new Date(this.now()).toISOString(), correction: Boolean(acknowledged && acknowledged.semanticRevision !== semanticRevision),
        materiality: item.materiality, claimStatus: item.claimStatus || "report-not-independently-corroborated", delivered: false };
      this.observed.set(candidateId, row);
      if (!acknowledged || acknowledged.semanticRevision !== semanticRevision) unique.set(factKey, row);
    }
    this.persist(); return [...unique.values()];
  }
  acknowledge({ candidateIds, deliveredAt }) {
    this.prune();
    if (Date.parse(deliveredAt) > this.now() + 60000) throw new AppError("No se puede reconocer una entrega futura.", 400, "INVALID_DELIVERY_TIME");
    const rows = candidateIds.map(id => this.observed.get(id));
    if (rows.some(row => !row)) throw new AppError("Solo se pueden reconocer candidatos observados y vigentes.", 400, "UNKNOWN_ALERT_CANDIDATE");
    for (const row of rows) this.acknowledged.set(row.factKey, { semanticRevision: row.semanticRevision, candidateId: row.candidateId, deliveredAt });
    this.persist(); return { acknowledged: rows.length, deliveredAt };
  }
  researchTransaction(fn) {
    const previous=structuredClone(this.research);
    try {const value=fn(this.research);if(Object.keys(this.research.scenarios).length>this.maxEntries||Object.keys(this.research.signals).length>this.maxEntries||Object.keys(this.research.consumers).length>1000)throw new AppError("Capacidad research agotada; archivar explícitamente.",507,"RESEARCH_CAPACITY");this.persist();return structuredClone(value??null);}
    catch(error){this.research=previous;throw error;}
  }
  appendChange(state,{kind,entityId,revision,snapshot,reason}) {
    const generatedAt=new Date(this.now()).toISOString();const sequence=++state.sequence;
    const row={changeId:`change-${sequence}-${stableHash([kind,entityId,revision]).slice(0,16)}`,sequence,kind,entityId,revision,reason:reason||null,generatedAt,observedAt:snapshot?.observedAt||generatedAt,instrumentId:snapshot?.instrumentId||null,snapshot:structuredClone(snapshot||null),deliveredAt:null,acknowledgedAt:null};state.changes.push(row);return row;
  }
  encodeChangeCursor(value) {const encoded=Buffer.from(JSON.stringify(value)).toString("base64url");return `${encoded}.${createHmac("sha256",this.research.cursorKey).update(encoded).digest("base64url")}`;}
  decodeChangeCursor(cursor) {
    try {const [encoded,signature,extra]=cursor.split(".");const expected=createHmac("sha256",this.research.cursorKey).update(encoded).digest();const actual=Buffer.from(signature||"","base64url");if(extra||expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error();
      const value=JSON.parse(Buffer.from(encoded,"base64url").toString());if(!Number.isInteger(value.after)||!Number.isInteger(value.upper)||value.after<0||value.after>value.upper||typeof value.consumerId!=="string"||!Array.isArray(value.instrumentIds))throw new Error();
      if(value.expiresAt<=this.now())throw new AppError("Cursor caducado; recuperar snapshot y checkpoint explícitamente.",410,"CURSOR_EXPIRED");return value;
    }catch(error){if(error instanceof AppError)throw error;throw new AppError("Cursor de cambios inválido.",400,"INVALID_CURSOR");}
  }
  validateConsumer(id) { if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(id||"")||["constructor","prototype","__proto__"].includes(id))throw new AppError("Identidad de consumidor inválida.",400,"INVALID_CONSUMER"); }
  delta({consumerId,cursor,instrumentIds,limit=20,maxBytes=262144}={}) {
    if(consumerId)this.validateConsumer(consumerId);
    const scope=[...new Set(instrumentIds||[])].sort();const current=cursor?this.decodeChangeCursor(cursor):{consumerId:consumerId||"research",after:this.research.consumers[consumerId||"research"]?.sequence||0,upper:this.research.sequence,instrumentIds:scope,expiresAt:this.now()+900000};
    this.validateConsumer(current.consumerId);
    if(consumerId&&consumerId!==current.consumerId||instrumentIds&&stableHash(scope)!==stableHash(current.instrumentIds))throw new AppError("Filtros distintos del cursor.",400,"CURSOR_FILTER_MISMATCH");
    const cutoff=new Date(this.now()-this.retentionDays*86400000).toISOString();const expired=this.research.changes.filter(c=>c.generatedAt<cutoff);const floor=Math.max(this.research.retainedAfter,expired.at(-1)?.sequence||0);
    if(current.after<floor)throw new AppError("Retención superada; no equivale a ausencia de novedades. Recuperar escenarios actuales y establecer checkpoint explícito.",410,"CHANGE_RETENTION_GAP");
    if(current.upper>this.research.sequence)throw new AppError("Ledger de cambios restaurado a una revisión anterior.",409,"CHANGE_HISTORY_CHANGED");
    const rows=this.research.changes.filter(c=>c.sequence>current.after&&c.sequence<=current.upper&&(!current.instrumentIds.length||current.instrumentIds.includes(c.instrumentId)));
    const data={consumerId:current.consumerId,changes:[],snapshotId:`changes-${current.upper}`,asOf:new Date(this.now()).toISOString(),throughSequence:current.after,hasMore:false,nextCursor:null,checkpointCursor:null,checkpoint:this.research.consumers[current.consumerId]||{sequence:0,acknowledgedAt:null},coverage:{retainedAfter:floor,latestSequence:this.research.sequence,retentionDays:this.retentionDays},delivery:{verified:false,receiptAvailable:false},warnings:["Reading does not advance checkpoints or acknowledge delivery.","No durable ChatGPT delivery receipt is available; checkpoint acknowledges processing only."]};
    const wireBytes=()=>{const payload={ok:true,queriedAt:data.asOf,origin:"OGID",data,warnings:data.warnings,truncated:false};return Buffer.byteLength(JSON.stringify({structuredContent:payload,content:[{type:"text",text:JSON.stringify(payload)}]}));};
    const update=()=>{const last=data.changes.at(-1)?.sequence||current.after;data.hasMore=rows.some(c=>c.sequence>last);data.throughSequence=data.hasMore?last:current.upper;const encoded=this.encodeChangeCursor({...current,after:data.throughSequence});data.checkpointCursor=encoded;data.nextCursor=data.hasMore?encoded:null;};
    update();for(const row of rows.slice(0,limit)){data.changes.push(structuredClone(row));update();if(wireBytes()>maxBytes-512){data.changes.pop();update();break;}}
    if(!data.changes.length&&rows.length)throw new AppError("Un cambio no cabe; aumentar presupuesto sin avanzar.",413,"SIGNAL_ITEM_TOO_LARGE");
    if(wireBytes()>maxBytes-512)throw new AppError("Metadata excede presupuesto.",413,"OUTPUT_TOO_LARGE");return data;
  }
  acknowledgeChanges({consumerId,checkpointCursor,expectedSequence}) {
    this.validateConsumer(consumerId);
    const cursor=this.decodeChangeCursor(checkpointCursor);if(cursor.consumerId!==consumerId)throw new AppError("Consumidor del checkpoint distinto.",400,"CURSOR_FILTER_MISMATCH");
    // Los checkpoints son de la secuencia global. No aceptar uno filtrado que omita otros activos.
    if(cursor.instrumentIds.length)throw new AppError("Reconocer requiere un delta global del consumidor.",400,"FILTERED_CHECKPOINT_FORBIDDEN");
    const current=this.research.consumers[consumerId]?.sequence||0;if(current!==expectedSequence||cursor.after<current||cursor.after>this.research.sequence)throw new AppError("Checkpoint concurrente o fuera de historia.",409,"CHECKPOINT_CONFLICT");
    return this.researchTransaction(state=>state.consumers[consumerId]={sequence:cursor.after,acknowledgedAt:new Date(this.now()).toISOString(),deliveryVerified:false,meaning:"consumer-processing-acknowledgement"});
  }
  recoverCheckpoint({consumerId,sequence,expectedSequence,reason}) {
    this.validateConsumer(consumerId);
    if(!reason||sequence!==this.research.sequence||(this.research.consumers[consumerId]?.sequence||0)!==expectedSequence)throw new AppError("Recuperación exige snapshot actual y comparación de checkpoint.",409,"CHECKPOINT_CONFLICT");
    return this.researchTransaction(state=>state.consumers[consumerId]={sequence,acknowledgedAt:new Date(this.now()).toISOString(),deliveryVerified:false,recovery:true,reason:String(reason).slice(0,200)});
  }

}
