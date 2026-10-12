import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("live SQL news follows country changes, ignores late replies and refreshes on a new revision",async()=>{
  const source=readFileSync(new URL("../../frontend/js/dashboard.js",import.meta.url),"utf8");
  const code=source.slice(source.indexOf("function liveNewsKey("),source.indexOf("function setWsStatus("));
  const pending=[],rendered=[],state={meta:{sourceMeta:{corpus:{revision:1,dayStart:"2026-10-08T22:00:00Z"}}},countries:{},ai:{}};
  let countries="RU";
  const context=vm.createContext({console,getState:()=>state,selectedCountryQueryValue:()=>countries,filterStateBySelection:value=>value,renderNews:news=>rendered.push(news),api:{getNews:input=>new Promise(resolve=>pending.push({input,resolve}))}});
  vm.runInContext(`let liveNewsView=null,liveNewsRequestKey=null,liveNewsRequestToken=0;${code}`,context);
  const first=context.refreshStoredLiveNews(state);assert.equal(pending[0].input.countries,"RU");
  countries="CN";const second=context.refreshStoredLiveNews(state);
  pending[1].resolve({news:[{id:"cn"}],meta:{}});await second;
  pending[0].resolve({news:[{id:"ru"}],meta:{}});await first;
  assert.deepEqual(rendered,[[{id:"cn"}]]);
  await context.refreshStoredLiveNews(state);assert.equal(pending.length,2);
  state.meta.sourceMeta.corpus.revision=2;const third=context.refreshStoredLiveNews(state);pending[2].resolve({news:[{id:"cn-new"}],meta:{}});await third;
  assert.equal(rendered.at(-1)[0].id,"cn-new");
});
