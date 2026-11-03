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
// Indexed, bounded authorization checks are prerequisites for cancellation
// and SSE recovery. They need the same reserved lane as lease/run control.
const controlReads = new Set(['runControl','deviceAuth','sessionAccess']);
// Panel metadata has bounded pagination and does not hydrate a news corpus.
// Creating a session or recording a request is a journal commit, not inference.
const boundedAgentReads = new Set(['sessions','messages','alerts','workerHealth','analysisSnapshotAccess']);
// Frozen pages and individual results retain normal-pressure admission, but
// do not wait for an unrelated CPU calculation's global heavy reservation.
const payloadAgentReads = new Set(['run','evidence','evidenceChunk','clusters','analysisDetail','analysisSections']);
const conversationJournal = new Set(['sessionCreate','requestAgent']);
export function storageOperationContract(operation,input={}) {
  const acquisition=['news.collect','news.supplemental','rss.fetch'].includes(operation) || operation==='domain.call' &&
    (input.service==='rss' && input.method==='refresh' || ['sources','history'].includes(input.service) && input.method==='run');
  const controlRead=['agent.call','agent.read'].includes(operation)&&controlReads.has(input.method);
  const boundedAgentRead=['agent.call','agent.read'].includes(operation)&&boundedAgentReads.has(input.method);
  const payloadAgentRead=['agent.call','agent.read'].includes(operation)&&payloadAgentReads.has(input.method);
  const journal=operation==='agent.call'&&conversationJournal.has(input.method);
  const pureRead=controlRead||boundedAgentRead||payloadAgentRead||['market.persist.pending','market.persist.status','market.project.pending','market.project.status','agent.read','scenarios.prepare','runtime.load','storage.status'].includes(operation) ||
    operation==='domain.call' && Boolean(queries[input.service]?.includes(input.method));
  let role='writer';
  if(pureRead)role=operation==='scenarios.prepare'?'analysis':'queries';
  if(operation==='storage.status')role='writer';
  if(operation==='runtime.load' && !['awareness','maintenance-inputs','dashboard-analysis','advanced-job'].includes(input.kind))role='writer';
  if(operation==='agent.snapshot' || operation==='domain.call' && (analysis.has(input.service) || input.service==='forecasts' && input.method==='evaluate' || input.service==='news' && input.method==='getProjection'))role='analysis';
  if(operation==='market.project.calculate')role='analysis';
  const domainControl=operation==='domain.call'&&(input.service==='sources'&&input.method==='stop'||input.service==='history'&&input.method==='cancel');
  const workClass=controlRead?'control':['snapshot.renew','snapshot.fail'].includes(operation)||domainControl?'control':operation==='agent.call' && controls.has(input.method)?'control':
    // Journal pages are bounded business commits. Waiting for every acquisition
    // workflow to end would starve them while RSS releases the writer for I/O.
    journal||operation==='agent.call'&&input.method==='alertSync'?'commit':
    ['snapshot.recover','domain.indexPage','storage.checkpoint','storage.verify','storage.import'].includes(operation) || operation==='domain.call' && input.service==='news' && input.method==='enrichEditorialPage'?'maintenance':
    acquisition?'acquisition':['market.persist.admit','market.persist.page','market.project.fail','market.project.reconcile','analysis.persist','runtime.save','pipeline.record'].includes(operation)?'commit':pureRead?'read':'calculation';
  const cheapRead=boundedAgentRead||['storage.status','runtime.load','market.persist.status','market.persist.pending','market.project.status','market.project.pending'].includes(operation)||operation==='agent.read'&&input.method==='status'||operation==='domain.call'&&(input.service==='situations'&&['list','status'].includes(input.method)||input.service==='news'&&input.method==='sourceAssessments');
  const resourceClass=workClass==='control'?'control':operation==='market.persist.admit'?'acquisition':journal||operation==='market.persist.page'||operation==='agent.call'&&input.method==='alertSync'?'journal':
    workClass==='commit'?'commit':cheapRead?'read':payloadAgentRead?'payload':workClass==='maintenance'?'maintenance':acquisition?'acquisition':'heavy';
  return {role,pureRead,workClass,resourceClass,effects:pureRead?'read-only':acquisition?'acquisition-and-commit':'may-commit',acquisition};
}
