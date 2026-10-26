import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceAssessmentCache,sourceAssessmentLabel,paintSourceAssessment} from '../../frontend/js/sourceAssessmentModel.js';
test('the medium meter has no central marker for unknown, disagreement or incompatible contexts',()=>{
  for(const status of ['unrated','not-applicable','unmapped','disputed','different-contexts','partial','unresolved','loading','unavailable']){
    const value=sourceAssessmentLabel({status,rating:'center'});assert.equal(value.position,-1);assert.ok(!value.text.includes('neutral'));
  }
  assert.equal(sourceAssessmentLabel({status:'rated',rating:'center'}).position,2);
  const label={textContent:''},marker={hidden:false,style:{setProperty(){}}};
  const link={href:'',title:'',setAttribute(){},querySelector:name=>name==='.source-rating-label'?label:marker};
  paintSourceAssessment(link,{status:'rated',rating:'right'});assert.equal(marker.hidden,false);
  paintSourceAssessment(link,{status:'unrated'});assert.equal(marker.hidden,true);assert.equal(link.querySelector('.source-rating-label'),label);assert.equal(label.textContent,'Tendencia del medio: sin evaluar');
});
test('assessment reads are shared, interest gated, cached and keep exact editions apart',async()=>{
  let now=1,calls=0,changed=0,release;
  const cache=new SourceAssessmentCache(async({cursor})=>{calls++;if(!cursor)await new Promise(r=>{release=r;});return {available:true,items:[{publisherId:'fixture',edition:cursor?'other.example':'wire.example',status:cursor?'unrated':'rated',rating:'left'}],hasMore:!cursor,nextCursor:cursor?null:'page2'};},{now:()=>now,onChange:()=>{changed++;}});
  const article={publisherId:'fixture',publisherResolution:{status:'resolved',domain:'sub.wire.example'}};
  await cache.refresh({interested:false});assert.equal(calls,0);assert.equal(cache.lookup(article).status,'loading');
  const first=cache.refresh(),second=cache.refresh();assert.equal(first,second);release();await first;
  assert.equal(calls,2);assert.equal(changed,1);assert.equal(cache.lookup(article).rating,'left');
  assert.equal(cache.lookup({...article,publisherResolution:{status:'resolved',domain:'other.example'}}).status,'unrated');
  assert.equal(cache.lookup({...article,publisherResolution:{status:'resolved',domain:'wire.example.fake'}}).status,'unavailable');
  assert.equal(cache.lookup({publisher:'Fixture'}).status,'unresolved');await cache.refresh();assert.equal(calls,2);
  now+=60001;cache.read=async()=>{throw Error('unavailable');};await cache.refresh();assert.equal(cache.lookup(article).status,'unavailable');
});
