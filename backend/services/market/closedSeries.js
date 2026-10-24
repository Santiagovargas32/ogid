import {aggregateClosedCandles} from './candleAggregationService.js';
import {assessClosedCandle} from './candleValidation.js';
import {stableHash} from '../../utils/stableHash.js';
import {CALENDAR_VERSION} from './exchangeCalendar.js';
export function resolveClosedSeries(store,{instrument,interval,adjustmentMode='splits',limit=500,asOf=new Date().toISOString()}) {
  const ratio=interval==='1h'?12:interval==='30min'?6:interval==='15min'?3:1,derived=ratio>1;
  const required=derived?(limit+2)*ratio:limit,requested=Math.min(10000,required);
  const raw=store.query({instrumentId:instrument.instrumentId,interval:derived?'5min':interval,adjustmentMode,limit:requested,to:asOf});
  const assessment=raw.map(c=>({c,a:assessClosedCandle(c,instrument,asOf)}));
  const baseCandles=assessment.filter(r=>r.a.eligible).map(r=>r.c);
  let bars=baseCandles,quality={rejectedCandles:assessment.filter(r=>!r.a.eligible).length,baseRequested:requested,baseRequired:required,lookbackLimited:requested<required};
  if(derived){
    if(interval==='30min'){
      // Use the same deterministic aggregation implementation, with its
      // registered 5-minute -> 30-minute contract.
      const rollup=aggregateClosedCandles(bars,{sourceInterval:'5min',targetInterval:'30min',instrument,asOf});bars=rollup.candles;quality={...quality,...rollup.quality};
    }else{
      const fifteen=aggregateClosedCandles(bars,{sourceInterval:'5min',targetInterval:'15min',instrument,asOf});
      const rollup=interval==='1h'?aggregateClosedCandles(fifteen.candles,{sourceInterval:'15min',targetInterval:'1h',instrument,asOf}):fifteen;
      bars=rollup.candles;quality={...quality,...rollup.quality,gapDetected:fifteen.quality.gapDetected||rollup.quality.gapDetected};
    }
  }
  quality.rejectedCandles=Math.max(quality.rejectedCandles||0,assessment.filter(r=>!r.a.eligible).length);
  const full=bars.filter(c=>!c.provenance?.partialSessionBucket);quality.partialSessionBuckets=bars.length-full.length;
  return {candles:full.slice(-limit),baseCandles,quality,lineage:{baseInterval:derived?'5min':interval,sourceRevision:stableHash(raw.map(c=>[c.openTime,c.revision,c.fetchedAt])),calendarVersion:CALENDAR_VERSION,methodVersion:'shared-closed-series-v1'}};
}
