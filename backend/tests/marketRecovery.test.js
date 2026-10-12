import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketDataService } from '../services/marketData/marketDataService.js';
import { fetchYahooQuotes } from '../services/market/providers/yahooProvider.js';
import { fetchMarketQuotes } from '../services/market/marketProviderRouter.js';
import { normalizeYahooQuote } from '../services/marketData/normalizer.js';

test('Yahoo zero usable observations exposes rejections instead of current prices',async()=>{
 const service=new MarketDataService({yahooClient:{quote:async()=>({GD:{symbol:'GD',regularMarketPrice:null,regularMarketTime:new Date()},BA:{symbol:'BA',regularMarketPrice:120}})}});
 const result=await fetchYahooQuotes({tickers:['GD','BA'],marketDataService:service});
 assert.equal(result.metrics.requested,2);assert.equal(result.metrics.returned,0);assert.equal(result.metrics.invalid,2);
 assert.equal(Object.keys(result.quotes).length,0);assert.equal(result.errors.filter(e=>e.code==='YAHOO_INVALID_OBSERVATION').length,2);
 const routed=await fetchMarketQuotes({provider:'yahoo',tickers:['GD','BA'],marketDataService:service});
 assert.equal(routed.sourceMode,'unavailable');assert.equal(routed.sourceMeta.effectiveProvider,null);
 assert.equal(routed.sourceMeta.unavailableBySymbol.GD.status,'unavailable');assert.equal(routed.sourceMeta.coverageByMode.syntheticFallback,0);
});

test('missing observation timestamp and nonpositive prices are never replaced with current time',()=>{
 for(const value of [{symbol:'GD',regularMarketPrice:100},{symbol:'GD',regularMarketPrice:0,regularMarketTime:new Date()},{symbol:'GD',regularMarketPrice:-1,regularMarketTime:new Date()}])assert.equal(normalizeYahooQuote(value),null);
});

test('valid Yahoo delayed observations count as usable and preserve market time',async()=>{
 const timestamp='2026-10-09T20:00:00.000Z';const service={fetchQuotes:async()=>[{symbol:'GD',price:100,timestamp,currency:'USD',exchange:'NYSE',marketState:'CLOSED'}]};
 const result=await fetchMarketQuotes({provider:'yahoo',tickers:['GD'],marketDataService:service});
 assert.equal(result.sourceMeta.webDelayedCount,1);assert.equal(result.sourceMeta.liveCount,0);
 assert.equal(result.sourceMeta.metrics.returned,1);assert.equal(result.quotes.GD.asOf,timestamp);
});
