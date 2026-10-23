import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {resolveLiveNewsLimit,filterNews} from "../../frontend/js/newsFeedModel.js";

test("live SQL news follows country changes, ignores late replies and refreshes on a new revision",async()=>{
  const source=readFileSync(new URL("../../frontend/js/dashboard.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function liveNewsKey("),source.indexOf("function setWsStatus("));
  const pending=[],rendered=[],state={meta:{sourceMeta:{corpus:{revision:1,dayStart:"2026-10-08T22:00:00Z"}}},countries:{},ai:{}};
  let countries="RU";
  const context=vm.createContext({console,AbortController,AbortSignal,dashboardController:new AbortController(),resolveLiveNewsLimit,getState:()=>state,selectedCountryQueryValue:()=>countries,filterStateBySelection:value=>value,renderNews:news=>rendered.push(news),api:{getNews:input=>new Promise(resolve=>pending.push({input,resolve}))}});
  vm.runInContext(`let newsInterest=null,newsDetailsRequested=false,liveNewsController=null,liveNewsTask=null,liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  const first=context.refreshStoredLiveNews(state);assert.equal(pending[0].input.countries,"RU");assert.equal(pending[0].input.limit,100);
  countries="CN";const second=context.refreshStoredLiveNews(state);
  pending[1].resolve({news:[{id:"cn"}],meta:{}});await second;
  pending[0].resolve({news:[{id:"ru"}],meta:{}});await first;
  assert.deepEqual(rendered,[[{id:"cn"}]]);
  await context.refreshStoredLiveNews(state);assert.equal(pending.length,2);
  state.meta.sourceMeta.corpus.revision=2;const third=context.refreshStoredLiveNews(state);pending[2].resolve({news:[{id:"cn-new"}],meta:{}});await third;
  assert.equal(rendered.at(-1)[0].id,"cn-new");
});

for(const displayLimit of [12,40,100])test(`live feed respects configured ${displayLimit} articles and preserves its SQL selection`,async()=>{
  const source=readFileSync(new URL("../../frontend/js/dashboard.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function renderDashboard("),source.indexOf("function setWsStatus("));
  const now=Date.now(),news=Array.from({length:displayLimit},(_,i)=>({id:`sql-${i}`,title:`Stored ${i}`,publishedAt:new Date(now-i*1000).toISOString()}));
  const state={news:[{id:"state-only"}],meta:{sourceMeta:{corpus:{revision:1,displayLimit,dayStart:"2026-10-12T22:00:00Z"}}},countries:{},ai:{},market:{}};
  const rendered=[];let requests=0,countries="ALL";
  const context=vm.createContext({console,AbortController,AbortSignal,dashboardController:new AbortController(),resolveLiveNewsLimit,newsOptions:{pageSize:100,page:3},forceNewsRender:false,selectedMarketSymbols:[],marketWatchlistLoaded:false,latestMarketConditions:null,latestMarketConditionsContext:null,latestMarketConditionsError:null,marketConditionsContextKey:()=>"fixture",getState:()=>state,selectedCountryQueryValue:()=>countries,filterStateBySelection:value=>value,renderNews:items=>rendered.push(items),renderMeta:()=>{},observeNewsSelection:()=>{},renderWhenChanged:()=>{},api:{getNews:async input=>{assert.equal(input.limit,displayLimit);requests++;return {news,meta:{}};}}});
  vm.runInContext(`let newsInterest=null,newsDetailsRequested=false,liveNewsController=null,liveNewsTask=null,liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  await context.refreshStoredLiveNews(state);
  state.pipelineStatus={fixture:{status:"running"}};context.renderDashboard(state);
  state.market={revision:"market-2"};context.renderDashboard(state);
  await context.refreshStoredLiveNews(state);
  assert.equal(requests,1);assert.deepEqual(rendered.at(-1),news);
  assert.equal(context.newsOptions.pageSize,displayLimit);
  if(displayLimit!==100){assert.equal(context.newsOptions.page,1);assert.equal(context.forceNewsRender,true);}
  const page=filterNews(rendered.at(-1),{now,pageSize:context.newsOptions.pageSize});assert.equal(page.items.length,displayLimit);assert.equal(page.pages,1);
  const overflow=filterNews([...news,{id:"extra",publishedAt:new Date(now).toISOString()}],{now,pageSize:context.newsOptions.pageSize});assert.equal(overflow.pages,2);assert.equal(overflow.items.length,displayLimit);
  countries="RU";context.renderDashboard(state);assert.deepEqual(rendered.at(-1),state.news);
  countries="ALL";state.meta.sourceMeta.corpus.revision=2;context.renderDashboard(state);assert.deepEqual(rendered.at(-1),state.news);
});

test("a display-limit change invalidates the live view without a corpus revision change",async()=>{
  const source=readFileSync(new URL("../../frontend/js/dashboard.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function liveNewsKey("),source.indexOf("function setWsStatus("));
  const state={meta:{sourceMeta:{corpus:{revision:1,displayLimit:40,dayStart:"2026-10-12T22:00:00Z"}}},countries:{},ai:{}};
  const requested=[],pending=[],rendered=[];
  const context=vm.createContext({console,AbortController,AbortSignal,dashboardController:new AbortController(),resolveLiveNewsLimit,getState:()=>state,selectedCountryQueryValue:()=>"ALL",filterStateBySelection:value=>value,renderNews:news=>rendered.push(news),api:{getNews:input=>{requested.push(input.limit);return new Promise(resolve=>pending.push(resolve));}}});
  vm.runInContext(`let newsInterest=null,newsDetailsRequested=false,liveNewsController=null,liveNewsTask=null,liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  const first=context.refreshStoredLiveNews(state);
  state.meta.sourceMeta.corpus.displayLimit=12;const second=context.refreshStoredLiveNews(state);
  pending[1]({news:[{id:"current"}],meta:{}});await second;
  pending[0]({news:[{id:"old-limit"}],meta:{}});await first;
  await context.refreshStoredLiveNews(state);
  assert.deepEqual(requested,[40,12]);assert.deepEqual(rendered,[[{id:"current"}]]);
  assert.equal(resolveLiveNewsLimit({meta:{sourceMeta:{selectionConfig:{displayLimit:12}}}}),12);
  assert.equal(resolveLiveNewsLimit({}),100);
});

test('compact news waits for explicit interest, shares the detail read and preserves the configured selection limit',async()=>{
  const source=readFileSync(new URL('../../frontend/js/dashboard.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function liveNewsKey('),source.indexOf('function setWsStatus('));
  const state={meta:{view:{profile:'dashboard-v1',news:{pageSize:20,availableCount:100,complete:false}},sourceMeta:{corpus:{revision:1,displayLimit:100}}},countries:{},ai:{}};
  let calls=0,release;const rendered=[];
  const context=vm.createContext({console,AbortController,AbortSignal,dashboardController:new AbortController(),resolveLiveNewsLimit,getState:()=>state,selectedCountryQueryValue:()=>'ALL',filterStateBySelection:value=>value,renderNews:news=>rendered.push(news),api:{getNews:input=>{calls++;assert.equal(input.limit,100);return new Promise(resolve=>{release=resolve;});}}});
  vm.runInContext(`let newsInterest=null,newsDetailsRequested=false,liveNewsController=null,liveNewsTask=null,liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  await context.refreshStoredLiveNews(state);assert.equal(calls,0);
  vm.runInContext('newsDetailsRequested=true',context);
  const first=context.refreshStoredLiveNews(state),second=context.refreshStoredLiveNews(state);assert.equal(first,second);assert.equal(calls,1);
  release({news:[{id:'detail'}],meta:{}});await first;assert.equal(rendered[0][0].id,'detail');
  vm.runInContext('newsInterest={interested:false}',context);state.meta.sourceMeta.corpus.revision=2;
  await context.refreshStoredLiveNews(state);assert.equal(calls,1);
});
