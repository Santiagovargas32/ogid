import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

function percentiles(values) {
  const sorted = [...values].sort((a,b)=>a-b);
  const at = p => sorted.length ? sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1)] : null;
  return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99) };
}

// Numeric samples only: no URLs, headers, payloads or credentials. Last minute
// for event-loop delay; last 512 completed requests for HTTP latency.
export class RuntimeMetrics {
  constructor() {
    this.lag = monitorEventLoopDelay({resolution:20});
    this.http = []; this.activeRequests = 0; this.requests = 0; this.errors = 0;
    this.ready = false; this.startupMs = null; this.timer = null;
  }
  start(startupMs) {
    if (this.timer) return;
    this.ready = true; this.startupMs = startupMs;
    this.cpu = process.cpuUsage(); this.sampleAt = performance.now();
    this.elu = performance.eventLoopUtilization();
    this.lag.enable();
    this.timer = setInterval(()=>this.lag.reset(),60_000);
    this.timer.unref?.();
  }
  stop() { this.ready=false; this.lag.disable(); clearInterval(this.timer); this.timer=null; }
  middleware() {
    return (_req,res,next)=>{
      const start=performance.now(); this.activeRequests++;
      let finished=false;
      const record=()=>{
        if(finished)return; finished=true;
        this.activeRequests--; this.requests++;
        if(res.statusCode>=500)this.errors++;
        this.http.push(performance.now()-start);
        if(this.http.length>512)this.http.shift();
      };
      res.once('finish',record); res.once('close',record); next();
    };
  }
  snapshot() {
    const elapsedMs=performance.now()-(this.sampleAt||performance.now());
    const cpu=this.cpu?process.cpuUsage(this.cpu):{user:0,system:0};
    return {
      ready:this.ready, startupMs:this.startupMs, memory:process.memoryUsage(),
      cpu:{...cpu,elapsedMs}, eventLoopUtilization:this.elu?performance.eventLoopUtilization(this.elu):null,
      eventLoopDelayMs:{p50:this.lag.percentile(50)/1e6,p95:this.lag.percentile(95)/1e6,p99:this.lag.percentile(99)/1e6,max:this.lag.max/1e6},
      http:{...percentiles(this.http),active:this.activeRequests,requests:this.requests,errors:this.errors}
    };
  }
}
