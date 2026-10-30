// Internal execution descriptors complement the public API contracts. Routing,
// timeout semantics and worker enforcement must consume the same descriptor.
const queries = {
  situations:['list','detail','revisions','changes','status'],
  admin:['history','historyRevision'], sources:['status','holdings'], history:['get','coverage','coverageState','coverageStates','repairPlan'], imports:['datasets','datasetsPage'],
  news:['search','getItem','getHistory','coverage','getFeed','getLiveFeed','sourceAssessments','sourceAssessment','sourceCoverage','sourceDossiers','sourceDossier','sourceDossierDrafts','sourceDossierDraft','comparisons','comparison','comparisonClaim','comparisonChanges'],
  candles:['query','latest','has','hasCandle','coverageSummary'], awareness:['getSnapshot'], events:['search']
};
const analysis = new Set(['market','technical','indicators','conditions','advanced','map','coupling','portfolio']);
const controls = new Set(['heartbeat','cancel','interruptClaim','cancelAcknowledged','progress','state','publish','link','expireLeases','control']);
export function storageOperationContract(operation,input={}) {
  const acquisition=['news.collect','news.supplemental','rss.fetch'].includes(operation) || operation==='domain.call' &&
    (input.service==='rss' && input.method==='refresh' || ['sources','history'].includes(input.service) && input.method==='run');
  const pureRead=['market.persist.pending','market.persist.status','market.project.pending','market.project.status','agent.read','scenarios.prepare','runtime.load','storage.status'].includes(operation) ||
    operation==='domain.call' && Boolean(queries[input.service]?.includes(input.method));
  let role='writer';
  if(pureRead)role=operation==='scenarios.prepare'?'analysis':'queries';
  if(operation==='storage.status')role='writer';
  if(operation==='runtime.load' && !['awareness','maintenance-inputs','dashboard-analysis','advanced-job'].includes(input.kind))role='writer';
  if(operation==='agent.snapshot' || operation==='domain.call' && (analysis.has(input.service) || input.service==='forecasts' && input.method==='evaluate' || input.service==='news' && input.method==='getProjection'))role='analysis';
  if(operation==='market.project.calculate')role='analysis';
  const domainControl=operation==='domain.call'&&(input.service==='sources'&&input.method==='stop'||input.service==='history'&&input.method==='cancel');
  const workClass=['snapshot.renew','snapshot.fail'].includes(operation)||domainControl?'control':operation==='agent.call' && controls.has(input.method)?'control':
    // Journal pages are bounded business commits. Waiting for every acquisition
    // workflow to end would starve them while RSS releases the writer for I/O.
    operation==='agent.call'&&input.method==='alertSync'?'commit':
    ['snapshot.recover','domain.indexPage','storage.checkpoint','storage.verify','storage.import'].includes(operation) || operation==='domain.call' && input.service==='news' && input.method==='enrichEditorialPage'?'maintenance':
    acquisition?'acquisition':['market.persist.admit','market.persist.page','market.project.fail','market.project.reconcile','analysis.persist','runtime.save','pipeline.record'].includes(operation)?'commit':pureRead?'read':'calculation';
  const cheapRead=['storage.status','runtime.load','market.persist.status','market.persist.pending','market.project.status','market.project.pending'].includes(operation)||operation==='agent.read'&&input.method==='status'||operation==='domain.call'&&input.service==='situations'&&input.method==='status';
  const resourceClass=workClass==='control'?'control':operation==='market.persist.admit'?'acquisition':operation==='market.persist.page'||operation==='agent.call'&&input.method==='alertSync'?'journal':
    workClass==='commit'?'commit':cheapRead?'read':workClass==='maintenance'?'maintenance':acquisition?'acquisition':'heavy';
  return {role,pureRead,workClass,resourceClass,effects:pureRead?'read-only':acquisition?'acquisition-and-commit':'may-commit',acquisition};
}
