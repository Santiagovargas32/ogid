import {resourcePressureDetails} from '../../utils/resourcePressureDetails.js';
import {publicProjection} from '../../utils/researchProjection.js';
import {safeValidationDetails} from './contracts.js';

// Preserve known publication JSON pointers, never arbitrary filesystem paths.
const narrativeField=/^\/(?:summary|(?:limitations|missingEvidence|invalidation|alternatives|contradictions)\/\d{1,3}|(?:drivers|scenarios|alertAssessments|intradayScenarios|synthesis|timeline|changes|impacts|contradictions)\/\d{1,3}\/(?:text|description|summary|mechanism|confirmation|invalidation)(?:\/\d{1,3})?)$/;
function details(raw){
 const safe=safeValidationDetails(raw);if(!safe)return null;
 const result=publicProjection(safe);
 if(typeof safe.field==='string'&&narrativeField.test(safe.field))result.field=safe.field;
 if(Array.isArray(safe.problems))result.problems=safe.problems.map(details);
 return result;
}
export function projectAgentRunMetadata(value){
 const projected=publicProjection(value);
 if(value?.resourcePressure)projected.resourcePressure=resourcePressureDetails(value.resourcePressure);
 if(value?.lastToolFailure?.resourcePressure&&projected.lastToolFailure)projected.lastToolFailure.resourcePressure=resourcePressureDetails(value.lastToolFailure.resourcePressure);
 if(Array.isArray(value?.validationAttempts))projected.validationAttempts=value.validationAttempts.slice(0,2).filter(row=>row&&typeof row==='object').map(row=>({...publicProjection(row),details:details(row.details)}));
 return projected;
}
