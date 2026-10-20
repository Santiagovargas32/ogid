import { buildPersistenceMetadata,filterPersistedQuotes } from "../services/market/marketHistoryStore.js";
import { MARKET_PROVIDER_SCHEMA_VERSION } from "../services/market/marketSnapshotMigration.js";
import { createLogger } from "../utils/logger.js";
import { stableHash } from "../utils/stableHash.js";
import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
const log=createLogger("backend/storage/pipelinePersistence");
const appendOnlyKinds=new Set(["awareness-audit","awareness-poll","quotes"]);

export class PipelinePersistence {
  constructor(manager){this.manager=manager;this.pending=new Set();this.pendingKeys=new Map();this.outcomes=new Map();this.sequence=0;this.deferredStages=new Map();}
  deferStageWrites(){this.stagesDeferred=true;}
  resumeStageWrites(){
    this.stagesDeferred=false;
    const entries=[...this.deferredStages.values()];this.deferredStages.clear();
    for(const entry of entries)this.save('pipeline-stage',entry.payload).then(()=>entry.waiters.forEach(w=>w.resolve()),error=>entry.waiters.forEach(w=>w.reject(error)));
  }
  get failure(){return [...this.outcomes.values()].find(outcome=>outcome.error)?.error || null;}
  save(kind,payload){
    // Configuration owns the writer during boot. Stage rows are latest-state
    // upserts: retain the latest per ID, and acknowledge only its actual commit.
    if(kind==='pipeline-stage' && this.stagesDeferred){
      const entry=this.deferredStages.get(payload.id)||{waiters:[]};entry.payload=payload;this.deferredStages.set(payload.id,entry);
      return new Promise((resolve,reject)=>entry.waiters.push({resolve,reject}));
    }
    // Append-only saves recover only the same record (or the same atomic quote batch).
    const identity=appendOnlyKinds.has(kind) ? stableHash(payload) : kind === "pipeline-stage" ? payload.id : kind === "ai-record" ? payload.enrichmentId : null;
    const key=JSON.stringify([kind,identity]);
    const sequence=++this.sequence;
    this.pendingKeys.set(key,(this.pendingKeys.get(key) || 0)+1);
    const settle=error=>{if((this.outcomes.get(key)?.sequence || 0)<sequence)this.outcomes.set(key,{sequence,error});};
    const task=this.manager.request("runtime.save",{kind,payload});this.pending.add(task);
    task.then(()=>settle(null),error=>{
      settle(error);
      log.error("pipeline_persistence_failed",{kind,code:error.code,causeCode:error.causeCode,command:error.diagnostic});
    }).finally(()=>{
      this.pending.delete(task);
      const remaining=this.pendingKeys.get(key)-1;
      if(remaining)this.pendingKeys.set(key,remaining);
      else {this.pendingKeys.delete(key);if(!this.outcomes.get(key)?.error)this.outcomes.delete(key);}
    });return task;
  }
  async flush(){while(this.pending.size)await Promise.allSettled([...this.pending]);if(this.failure)throw this.failure;}
  async hydrate({awarenessStore,aiStore,aiBudget,marketHistoryStore,quotaTracker}){
    const startupTimeoutMs=this.manager.options?.startupTimeoutMs ?? RUNTIME_POLICY.storage.startupTimeoutMs;
    const load=kind=>this.manager.request("runtime.load",{kind},{timeoutMs:startupTimeoutMs,queueTimeoutMs:startupTimeoutMs});
    const [awareness,ai,budget,quotas]=await Promise.all([load("awareness"),load("ai"),load("ai-budget"),load("provider-quota")]);
    if(quotas?.providers)for(const [provider,saved]of Object.entries(quotas.providers)){quotaTracker.ensureProvider(provider);Object.assign(quotaTracker.providers[provider],saved);}
    quotaTracker.persist=()=>this.save("provider-quota",{version:1,providers:Object.fromEntries(Object.entries(quotaTracker.providers).map(([provider,s])=>[provider,Object.fromEntries(["events","headerLimit","headerRemaining","apiCreditsUsed","apiCreditsLeft","lastCallAt","lastStatus"].map(k=>[k,s[k]]))]))});
    if(awareness){awarenessStore.events=new Map((awareness.events || []).map(e=>[e.eventId,e]));for(const s of awareness.sourceStatus || [])awarenessStore.sourceStatuses.set(s.sourceId,s);awarenessStore.revision=awareness.revision || 0;for(const {sourceId,poll}of awareness.polls || []){if(!awarenessStore.pollHistories.has(sourceId))awarenessStore.pollHistories.set(sourceId,[]);awarenessStore.pollHistories.get(sourceId).push(poll);}}
    if(ai){aiStore.records=new Map((ai.records || []).map(r=>[r.enrichmentId,r]));}
    if(budget?.state)aiBudget.state=budget.state;
    aiStore.persist=()=>{};const upsert=aiStore.upsert.bind(aiStore);aiStore.upsert=record=>{const result=upsert(record);this.save("ai-record",result);return result;};aiStore.recoverInterrupted();for(const row of aiStore.records.values())if(row.validation?.codes?.includes("RESTART_INTERRUPTED"))this.save("ai-record",row);
    // Only the active Awareness projection stays in memory; audit/poll rows live in SQL.
    awarenessStore.persist=()=>this.save("awareness",{schemaVersion:"awareness-v1",revision:awarenessStore.revision,sourceStatus:[...awarenessStore.sourceStatuses.values()]});
    const prune=awarenessStore.prune.bind(awarenessStore);
    awarenessStore.prune=()=>{prune();if(awarenessStore.events.size<=1000)return;const now=Date.now(),rank=e=>e.scheduledAt&&Date.parse(e.scheduledAt)>=now&&["scheduled","live"].includes(e.status)?1:0;const rows=[...awarenessStore.events.values()].sort((a,b)=>rank(b)-rank(a)||Date.parse(b.observedAt)-Date.parse(a.observedAt));awarenessStore.events=new Map(rows.slice(0,1000).map(e=>[e.eventId,e]));};
    const reconcile=async(method,args)=>{await this.flush();const result=await this.manager.request("domain.call",{service:"awareness",method,args});for(const event of result.changed || [])awarenessStore.events.set(event.eventId,event);awarenessStore.revision=Math.max(awarenessStore.revision,result.revision);if(result.sourceStatus)awarenessStore.sourceStatuses.set(result.sourceStatus.sourceId,result.sourceStatus);awarenessStore.prune();return result;};
    awarenessStore.reconcile=(...args)=>reconcile("reconcile",args);
    awarenessStore.setSourceStale=(...args)=>reconcile("setSourceStale",args);
    awarenessStore.appendAudit=event=>this.save("awareness-audit",{recordedAt:new Date().toISOString(),event});
    awarenessStore.appendPollAudit=(sourceId,poll)=>this.save("awareness-poll",{recordedAt:poll.completedAt,sourceId,poll});
    awarenessStore.persist();
    aiBudget.persist=()=>this.save("ai-budget",{version:1,state:aiBudget.state});
    // The longer deadline belongs to boot hydration, not subsequent runtime reads.
    marketHistoryStore.loadSnapshot=()=>this.manager.request("runtime.load",{kind:"market"});marketHistoryStore.ensureDirectories=async()=>{};
    marketHistoryStore.loadTickerHistory=ticker=>this.manager.request("domain.call",{service:"quotes",method:"history",args:[ticker]});
    marketHistoryStore.saveSnapshot=async(marketState,decision,options={})=>{
      const savedAt=new Date().toISOString();marketState.sourceMeta={...marketState.sourceMeta,...buildPersistenceMetadata({eligible:true,reason:decision.reason,trigger:options.trigger || null,providerBacked:decision.providerBacked,savedAt})};
      await this.save("market",{providerSchemaVersion:MARKET_PROVIDER_SCHEMA_VERSION,provider:marketState.provider,sourceMode:marketState.sourceMode,sourceMeta:marketState.sourceMeta,revision:marketState.revision,session:marketState.session,updatedAt:marketState.updatedAt,tickers:Object.keys(marketState.quotes || {}),quotes:filterPersistedQuotes(marketState.quotes,decision.providerBacked)});
      Object.assign(marketHistoryStore.status,{lastSavedAt:savedAt,lastSavedMarketUpdatedAt:marketState.updatedAt,lastPersistReason:decision.reason,lastPersistenceEligible:true,lastSkipReason:null});return marketHistoryStore.getStatus();
    };
    marketHistoryStore.appendHistory=(_previous,marketState)=>this.save("quotes",marketState);
  }
}
