import { stableHash } from '../../utils/stableHash.js';
import { getInstrumentById } from '../market/instrumentRegistry.js';
import { resolveExpectedClosedDailyCandle } from '../market/dailyCandleService.js';
import { CALENDAR_VERSION } from '../market/exchangeCalendar.js';
import { expectedPublicableCandle, providerPublicationPolicy } from '../market/candleValidation.js';

// One timer drives bounded durable work. One analytical sweep may run alongside
// it on the existing readers; slow analysis cannot hold the next journal page.
export class AgentMaintenance {
  constructor({call,business,context,dependencies=null,now=Date.now,instruments=()=>[],enabled=false}) {
    Object.assign(this,{call,business,context,dependencies,now,instruments,enabled});
    this.status={state:'idle',lastSuccessAt:null,errorCode:null};
    this.completedInputs=new Map();
  }
  tick() {
    if(this.task)return this.completion;
    clearTimeout(this.timer);this.timer=null;
    this.task=this.run().catch(error=>{
      this.controlError=error.code||'AGENT_MAINTENANCE_FAILED';
    }).finally(()=>{
      this.task=null;this.refreshStatus();
      if(this.running&&!this.stopping){
        const failed=this.controlError||this.status.domains?.alerts?.state==='degraded';
        const delay=failed?60000:this.alertsPending
          ?Math.min(1000,Math.max(100,Math.ceil(this.alertPageMs||0)))
          :this.analyticalTask?1000:60000;
        this.status.nextEligibleAt=new Date(this.now()+delay).toISOString();
        this.timer=setTimeout(()=>{this.timer=null;void this.tick();},delay);this.timer.unref?.();
      }
    });
    // Callers can still await a full sweep. The control lock and timer are
    // released independently, so another tick can consume while it is pending.
    this.completion=this.task.then(()=>this.analyticalTask);
    return this.completion;
  }
  refreshStatus() {
    const domains=this.status.domains||{};
    const failure=Object.values(domains).find(d=>d.state==='degraded');
    const running=Object.keys(domains).find(name=>domains[name].state==='running');
    const errorCode=this.controlError||this.analyticalError||failure?.errorCode||null;
    this.status={...this.status,state:this.stopping?'stopped':errorCode?'degraded':running?'running':'ready',
      currentDomain:running||null,errorCode,
      analytical:{running:Boolean(this.analyticalTask),nextEligibleAt:this.analyticalNextAt?new Date(this.analyticalNextAt).toISOString():null},
      lastSuccessAt:!this.stopping&&!errorCode&&!running&&!this.alertsPending?new Date(this.now()).toISOString():this.status.lastSuccessAt};
  }
  async run({force=false}={}) {
    if(!this.enabled||this.stopping)return;
    const inputs=await this.dependencies?.();
    this.controlError=null;
    this.status.startedAt=new Date(this.now()).toISOString();
    const now=this.now(),asOf=new Date(now);
    const revisionFor=domain=>{
      if(!inputs)return null;
      const temporal=inputs.news?.hasRecentNews?Math.floor(now/60000):null;
      const d=inputs.situations;
      const durable=d?[d.initialized,d.state,d.domainSequence,d.outboxSequence,d.bootstrap,d.streams?.map(s=>[s.stream,s.lastSequence,s.headSequence,s.continuation,s.errorCode])]:null;
      if(domain.startsWith('technical:')){
        const [,id,interval]=domain.split(':'),instrument=getInstrumentById(id),policy=providerPublicationPolicy(instrument);
        const expected=interval==='1day'?resolveExpectedClosedDailyCandle(instrument,asOf,{equityDelayMinutes:(policy.delayMs+policy.graceMs)/60000})?.closeTime:expectedPublicableCandle(instrument,interval,asOf).expectedLatestCandleAt;
        const baseInterval=['15min','30min','1h'].includes(interval)?'5min':interval;
        return stableHash([inputs.candles[`candles.revision:provider-yahoo:${id}:${baseInterval}:splits`]||0,inputs.candles[`candles.revision:provider-yahoo:${id}:${interval}:splits`]||0,expected,CALENDAR_VERSION,'shared-closed-series-v1']);
      }
      return stableHash(domain==='alerts'?[inputs.news?.revision,inputs.awareness,inputs.research,durable]:domain==='evaluation'?[inputs.research,inputs.candles]:[inputs.news?.revision,inputs.awareness,inputs.market,inputs.signals,inputs.candles,temporal]);
    };
    const execute=async operations=>{
      for(const [domain,work]of operations){
        if(this.stopping)break;
        const revision=revisionFor(domain),previous=this.status.domains?.[domain];
        const pending=domain==='alerts'&&(this.alertsPending||inputs?.situations?.hasMore);
        if(domain!=='editorial'&&!pending&&!force&&revision&&this.completedInputs.get(domain)===revision){
          this.status.domains={...this.status.domains,[domain]:{...previous,state:'ready',deferredReason:'inputs-unchanged',inputRevision:revision}};continue;
        }
        this.status={...this.status,state:'running',currentDomain:domain,domains:{...this.status.domains,[domain]:{state:'running',startedAt:new Date(this.now()).toISOString()}}};
        const started=performance.now();
        try{
          const result=await work();
          if(domain==='alerts'){
            this.alertsPending=result?.hasMore===true;
            // Include queue/commit time, but let bounded pages return to the
            // fair writer queue instead of idling a minute behind new input.
            this.alertPageMs=Math.max(performance.now()-started,result?.durationMs||0);
          }
          if(revision&&!(domain==='alerts'&&this.alertsPending))this.completedInputs.set(domain,revision);
          this.status.domains={...this.status.domains,[domain]:{state:'ready',inputRevision:revision,lastSuccessAt:new Date(this.now()).toISOString(),
            ...(domain==='alerts'&&result?{hasMore:result.hasMore,processed:result.processed,streams:result.streams,bootstrap:result.bootstrap}:{} )}};
        }catch(error){
          this.status.domains={...this.status.domains,[domain]:{state:'degraded',errorCode:error.code||'AGENT_PREREQUISITE_UNAVAILABLE',lastSuccessAt:previous?.lastSuccessAt||null}};
        }
      }
    };
    await execute([
      ...(!this.editorialComplete&&this.business.news?.enrichEditorialPage?[["editorial",async()=>{const r=await this.business.news.enrichEditorialPage({});this.editorialComplete=r.complete===true;}]]:[]),
      ['alerts',()=>this.call('alertSync')],
    ]);
    if(!this.stopping&&!this.analyticalTask&&(force||!this.analyticalNextAt||now>=this.analyticalNextAt)){
      this.analyticalError=null;
      this.analyticalTask=execute([
        ['advanced',()=>this.business.advanced.getSnapshot({})],
        ['conditions',()=>this.business.conditions.getSnapshot({windowMin:1440})],
        ['evaluation',()=>this.business.forecasts.evaluate({})],
        ...this.instruments().flatMap(instrumentId=>['1day','1h','15min'].map(interval=>[`technical:${instrumentId}:${interval}`,()=>this.business.technical.get({instrumentId,interval})])),
      ]).catch(error=>{this.analyticalError=error.code||'AGENT_PREREQUISITE_UNAVAILABLE';}).finally(()=>{
        this.analyticalTask=null;
        // A fast journal retry must not regenerate the analytical corpus on
        // every page. Coalesce new inputs until the existing one-minute cadence.
        this.analyticalNextAt=this.now()+60000;this.refreshStatus();
      });
    }
  }
  start() {
    if(!this.enabled||this.running)return;
    this.running=true;this.stopping=false;void this.tick();
  }
  async stop() {
    this.stopping=true;this.running=false;clearTimeout(this.timer);this.timer=null;
    this.status.nextEligibleAt=null;
    await this.task;await this.analyticalTask;this.refreshStatus();
  }
}
