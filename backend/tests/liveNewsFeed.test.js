import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {LIVE_NEWS_LIMIT,filterNews} from "../../frontend/js/newsFeedModel.js";

test("live SQL news follows country changes, ignores late replies and refreshes on a new revision",async()=>{
  const source=readFileSync(new URL("../../frontend/js/dashboard.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function liveNewsKey("),source.indexOf("function setWsStatus("));
  const pending=[],rendered=[],state={meta:{sourceMeta:{corpus:{revision:1,dayStart:"2026-10-08T22:00:00Z"}}},countries:{},ai:{}};
  let countries="RU";
  const context=vm.createContext({console,LIVE_NEWS_LIMIT,getState:()=>state,selectedCountryQueryValue:()=>countries,filterStateBySelection:value=>value,renderNews:news=>rendered.push(news),api:{getNews:input=>new Promise(resolve=>pending.push({input,resolve}))}});
  vm.runInContext(`let liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  const first=context.refreshStoredLiveNews(state);assert.equal(pending[0].input.countries,"RU");assert.equal(pending[0].input.limit,100);
  countries="CN";const second=context.refreshStoredLiveNews(state);
  pending[1].resolve({news:[{id:"cn"}],meta:{}});await second;
  pending[0].resolve({news:[{id:"ru"}],meta:{}});await first;
  assert.deepEqual(rendered,[[{id:"cn"}]]);
  await context.refreshStoredLiveNews(state);assert.equal(pending.length,2);
  state.meta.sourceMeta.corpus.revision=2;const third=context.refreshStoredLiveNews(state);pending[2].resolve({news:[{id:"cn-new"}],meta:{}});await third;
  assert.equal(rendered.at(-1)[0].id,"cn-new");
});

test("live feed shows 100 articles and preserves its SQL selection during unrelated state updates",async()=>{
  const source=readFileSync(new URL("../../frontend/js/dashboard.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function renderDashboard("),source.indexOf("function setWsStatus("));
  const now=Date.now(),news=Array.from({length:100},(_,i)=>({id:`sql-${i}`,title:`Stored ${i}`,publishedAt:new Date(now-i*1000).toISOString()}));
  const state={news:[{id:"state-only"}],meta:{sourceMeta:{corpus:{revision:1,dayStart:"2026-10-12T22:00:00Z"}}},countries:{},ai:{},market:{}};
  const rendered=[];let requests=0,countries="ALL";
  const context=vm.createContext({console,LIVE_NEWS_LIMIT,selectedMarketSymbols:[],marketWatchlistLoaded:false,latestMarketConditions:null,latestMarketConditionsContext:null,latestMarketConditionsError:null,marketConditionsContextKey:()=>"fixture",getState:()=>state,selectedCountryQueryValue:()=>countries,filterStateBySelection:value=>value,renderNews:items=>rendered.push(items),renderMeta:()=>{},observeNewsSelection:()=>{},renderWhenChanged:()=>{},api:{getNews:async input=>{assert.equal(input.limit,100);requests++;return {news,meta:{}};}}});
  vm.runInContext(`let liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  await context.refreshStoredLiveNews(state);
  state.pipelineStatus={fixture:{status:"running"}};context.renderDashboard(state);
  state.market={revision:"market-2"};context.renderDashboard(state);
  await context.refreshStoredLiveNews(state);
  assert.equal(requests,1);assert.deepEqual(rendered.at(-1),news);
  const page=filterNews(rendered.at(-1),{now});assert.equal(page.items.length,100);assert.equal(page.pages,1);
  const overflow=filterNews([...news,{id:"extra",publishedAt:new Date(now).toISOString()}],{now});assert.equal(overflow.pages,2);assert.equal(overflow.items.length,100);
  countries="RU";context.renderDashboard(state);assert.deepEqual(rendered.at(-1),state.news);
  countries="ALL";state.meta.sourceMeta.corpus.revision=2;context.renderDashboard(state);assert.deepEqual(rendered.at(-1),state.news);
});
