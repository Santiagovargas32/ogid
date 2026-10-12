import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebSocketUpgradeOrigin, sendBoundedEnvelope } from '../websocket/socketServer.js';
import { fetchYahooQuotes } from '../services/market/providers/yahooProvider.js';
import RefreshOrchestratorService from '../services/refreshOrchestratorService.js';
import { EventLedger } from '../services/research/eventLedger.js';
import { ResearchStore } from '../services/research/researchStore.js';

test('untrusted forwarding headers cannot change the WebSocket origin', () => {
  const request = { headers: { host: '192.168.1.10:3000', origin: 'https://192.168.1.10:3000', 'x-forwarded-proto': 'https' }, socket: {remoteAddress:'192.168.1.20'} };
  assert.equal(validateWebSocketUpgradeOrigin(request).allowed, false);
});

test('scoped event search preserves total, order and isolated metadata after limiting',()=>{
  const store=new ResearchStore();const ledger=new EventLedger({store});
  ledger.ingest([
    {id:'first',title:'First sourced report',url:'https://fixture.test/1',instrumentIds:['us-equity-general-dynamics'],publishedAt:'2026-10-11T12:00:00Z'},
    {id:'second',title:'Second sourced report',url:'https://fixture.test/2',instrumentIds:['us-equity-general-dynamics'],publishedAt:'2026-10-11T13:00:00Z'},
    {id:'other',title:'Unrelated country report',url:'https://fixture.test/3',publishedAt:'2026-10-11T14:00:00Z'}
  ]);
  const result=ledger.search({instrumentIds:['us-equity-general-dynamics'],limit:1});
  assert.equal(result.total,2);assert.equal(result.events.length,1);assert.equal(result.hasMore,true);
  const id=result.events[0].eventId;const original=store.state.events[id].evidence[0].title;
  result.events[0].evidence[0].title='mutated';result.events[0].quality.identityVerified=false;
  assert.equal(store.state.events[id].evidence[0].title,original);
  assert.equal(store.state.events[id].quality.identityVerified,true);
});

test('temporarily slow WebSocket queues within its byte budget', () => {
  const calls = [];
  const client = {readyState:1, bufferedAmount:999_999, close:(...args)=>calls.push(['close',...args]), terminate:()=>calls.push(['terminate']), send:()=>calls.push(['send']), once:()=>{}};
  sendBoundedEnvelope(client, 'abcd');
  assert.deepEqual(calls, []);
  assert.equal(client.boundedTransport.queue.length,1);
  clearInterval(client.boundedTransport.timer);
});

for (const status of [403,429,500]) test(`Yahoo batch HTTP ${status} does not fan out`, async () => {
  let calls = 0;
  const result = await fetchYahooQuotes({tickers:['GD','BA'], marketDataService:{fetchQuotes:async()=>{calls++;throw Object.assign(Error('fixture'),{status});}}});
  assert.equal(calls,1);
  assert.equal(result.errors[0].httpStatus,status);
});

test('news and market callers join active cycles including RSS selection', async () => {
  const orchestrator = new RefreshOrchestratorService({stateManager:{},socketServer:{},config:{market:{enabled:true}}});
  let release;
  const barrier = new Promise(resolve=>{release=resolve;});
  let news = 0, market = 0;
  let active = 0, maxActive = 0;
  orchestrator.executeNewsCycle = async()=>{news++; active++; maxActive=Math.max(maxActive,active); await barrier; active--;};
  orchestrator.executeMarketCycle = async()=>{market++;await barrier;};
  const a = orchestrator.runNewsCycle('test');
  const b = orchestrator.runNewsCycle('rss-selected',{rssOnly:true});
  const c = orchestrator.runMarketCycle('test');
  const d = orchestrator.runMarketCycle('test');
  release();
  await Promise.all([a,b,c,d]);
  assert.equal(news,2); // full cycle, then one coalesced selection of newest RSS
  assert.equal(maxActive,1);
  assert.equal(market,1);
});
