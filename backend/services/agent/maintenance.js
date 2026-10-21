import { stableHash } from '../../utils/stableHash.js';
import { getInstrumentById } from '../market/instrumentRegistry.js';
import { resolveExpectedClosedDailyCandle } from '../market/dailyCandleService.js';
import { sessionPolicyResolver } from '../market/sessionPolicyResolver.js';
import { candleIntervalMs } from '../market/canonicalCandle.js';
// Owns deterministic prerequisites and alerts independently of browser traffic.
// Existing readers compute; all mutations continue through StorageManager.
export class AgentMaintenance {
  constructor({
    call,
    business,
    context,
    dependencies = null,
    now = Date.now,
    instruments = () => [],
    enabled = false,
  }) {
    Object.assign(this, { call, business, context, dependencies, now, instruments, enabled });
    this.status = { state: "idle", lastSuccessAt: null, errorCode: null };
  }
  tick() {
    if (this.task) return this.task;
    this.task = this.run()
      .catch((e) => {
        this.status = {
          ...this.status,
          state: "degraded",
          errorCode: e.code || "AGENT_MAINTENANCE_FAILED",
        };
      })
      .finally(() => {
        this.task = null;
      });
    return this.task;
  }
  async run({force=false}={}) {
    if (!this.enabled) return;
    const inputs=await this.dependencies?.();
    const now=this.now(),asOf=new Date(now);
    this.completedInputs ||= new Map();
    const revisionFor=domain=>{
      if(!inputs)return null;
      const temporal=inputs.news?.hasRecentNews?Math.floor(now/60000):null;
      if(domain.startsWith('technical:')){
        const [,id,interval]=domain.split(':');const instrument=getInstrumentById(id);
        const expected=interval==='1day'?resolveExpectedClosedDailyCandle(instrument,asOf)?.closeTime:sessionPolicyResolver.resolve(instrument,asOf,{intervalMs:candleIntervalMs(interval)}).expectedLatestCandleAt;
        return stableHash([inputs.candles[`candles.revision:provider-yahoo:${id}:${interval}:splits`] || 0,expected]);
      }
      return stableHash(domain==='alerts'?[inputs.news?.revision,inputs.awareness,inputs.research]:domain==='evaluation'?[inputs.research,inputs.candles]:[inputs.news?.revision,inputs.awareness,inputs.market,inputs.signals,inputs.candles,temporal]);
    };
    const operations = [
      ["alerts", () => this.call("alertSync")],
      ["advanced", () => this.business.advanced.getSnapshot({})],
      [
        "conditions",
        () => this.business.conditions.getSnapshot({ windowMin: 1440 }),
      ],
      ["evaluation", () => this.business.forecasts.evaluate({})],
      ...this.instruments().flatMap((instrumentId) =>
        ["1day", "1h", "15min"].map((interval) => [
          `technical:${instrumentId}:${interval}`,
          () => this.business.technical.get({ instrumentId, interval }),
        ]),
      ),
    ];
    const previousDomains = this.status.domains || {};
    const domains = {};
    this.status={...this.status,state:"running",errorCode:null,startedAt:new Date().toISOString()};
    for (const [domain, execute] of operations) {
      if (this.stopping) break;
      const revision=revisionFor(domain);
      if(!force && revision && this.completedInputs.get(domain)===revision){domains[domain]={...previousDomains[domain],state:'ready',deferredReason:'inputs-unchanged',inputRevision:revision};continue;}
      this.status={...this.status,currentDomain:domain,domains:{...domains,[domain]:{state:"running",startedAt:new Date().toISOString()}}};
      try {
        await execute();
        if(revision)this.completedInputs.set(domain,revision);
        domains[domain] = {
          state: "ready",
          inputRevision:revision,
          lastSuccessAt: new Date().toISOString(),
        };
      } catch (e) {
        domains[domain] = {
          state: "degraded",
          errorCode: e.code || "AGENT_PREREQUISITE_UNAVAILABLE",
          lastSuccessAt: previousDomains[domain]?.lastSuccessAt || null,
        };
      }
      this.status={...this.status,domains:{...domains}};
    }
    const failure = Object.values(domains).find((d) => d.state === "degraded");
    this.status = {
      ...this.status,
      state: this.stopping ? 'stopped' : failure ? "degraded" : "ready",
      currentDomain:null,
      domains,
      errorCode: failure?.errorCode || null,
      lastSuccessAt: failure || this.stopping
        ? this.status.lastSuccessAt
        : new Date().toISOString(),
    };
  }
  start() {
    if (!this.enabled || this.timer) return;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60000);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    await this.task;
  }
}
