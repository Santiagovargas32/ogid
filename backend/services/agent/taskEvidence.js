// Select the bounded first page for this task; never inject source bodies into
// the prompt or treat this index as proof that the model consulted the sources.
export function taskEvidenceDomain(job) {
  switch (job.task) {
    case 'global_intelligence_brief':
      return (job.input?.context || job.input?.appContext)?.alertId ? 'geopolitical-alert' : 'news';
    case 'geopolitical_alert_assessment': return 'geopolitical-alert';
    case 'market_outlook_global':
    case 'instrument_outlook': return 'technical.get';
    case 'situation_analysis': return 'situation-source';
    default: return undefined;
  }
}

export async function taskEvidencePlan(call, snapshotId, job) {
  const domain = taskEvidenceDomain(job);
  let catalog = await call('evidence', {snapshotId, ...(domain ? {domain} : {}), limit:20});
  const hasSources = Boolean(domain && (catalog?.items?.length || catalog?.hasMore));
  if (domain && !hasSources) catalog = await call('evidence', {snapshotId, domain:'coverage', limit:1});
  const selectedDomain = domain && !hasSources ? 'coverage' : domain;
  return {
    hasSources,
    readParameters: {snapshotId, ...(selectedDomain ? {domain:selectedDomain} : {}), limit:5},
    index: {snapshotId, domain:selectedDomain, items:(catalog?.items || []).map(e => ({
      evidenceId:e.evidenceId, domain:e.domain, quality:e.quality, publicationEligibility:e.publicationEligibility,
    })), hasMore:catalog?.hasMore, nextCursor:catalog?.nextCursor},
  };
}
