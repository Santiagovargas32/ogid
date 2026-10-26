// Internal execution descriptors complement the public API contracts. Routing,
// timeout semantics and worker enforcement must consume the same descriptor.
const queries = {
  admin:['history','historyRevision'], sources:['status','holdings'], history:['get','coverage','coverageState','coverageStates','repairPlan'], imports:['datasets','datasetsPage'],
  news:['search','getItem','getHistory','coverage','getFeed','getLiveFeed','sourceAssessments','sourceAssessment','sourceCoverage'],
  candles:['query','latest','has','hasCandle','coverageSummary'], awareness:['getSnapshot'], events:['search']
};
const analysis = new Set(['market','technical','indicators','conditions','advanced','map','coupling','portfolio']);
const controls = new Set(['heartbeat','cancel','interruptClaim','cancelAcknowledged','progress','state','publish','link']);
export function storageOperationContract(operation,input={}) {
  const acquisition=['news.collect','news.supplemental','rss.fetch'].includes(operation) || operation==='domain.call' &&
    (input.service==='rss' && input.method==='refresh' || ['sources','history'].includes(input.service) && input.method==='run');
  const pureRead=['market.persist.pending','market.persist.status','agent.read','scenarios.prepare','runtime.load','storage.status'].includes(operation) ||
    operation==='domain.call' && Boolean(queries[input.service]?.includes(input.method));
  let role='writer';
  if(pureRead)role=operation==='scenarios.prepare'?'analysis':'queries';
  if(operation==='storage.status')role='writer';
  if(operation==='runtime.load' && !['awareness','maintenance-inputs','dashboard-analysis','advanced-job'].includes(input.kind))role='writer';
  if(operation==='agent.snapshot' || operation==='domain.call' && (analysis.has(input.service) || input.service==='forecasts' && input.method==='evaluate' || input.service==='news' && input.method==='getProjection'))role='analysis';
  const workClass=operation==='snapshot.renew'?'control':operation==='agent.call' && controls.has(input.method)?'control':
    ['snapshot.recover','domain.indexPage','storage.checkpoint','storage.verify','storage.import'].includes(operation) || operation==='domain.call' && input.service==='news' && input.method==='enrichEditorialPage'?'maintenance':
    acquisition?'acquisition':['market.persist.admit','market.persist.page','analysis.persist','runtime.save','pipeline.record'].includes(operation)?'commit':pureRead?'read':'calculation';
  return {role,pureRead,workClass,effects:pureRead?'read-only':acquisition?'acquisition-and-commit':'may-commit',acquisition};
}
