import { computeMarketImpact } from './impactEngineService.js';
import { generatePredictions } from './predictionEngineService.js';
import { generateInsights } from '../insightService.js';
export function calculateMarketProjection(input) {
  const asOf=input.asOf ?? new Date().toISOString();
  const predictions=generatePredictions({...input,asOf});
  const impact=computeMarketImpact({...input,asOf,predictionScores:predictions.predictionScoreByTicker || {}});
  const insights=generateInsights({countries:input.countries,previousCountries:input.countries,inputMode:input.inputMode});
  return {predictions,impact,insights};
}
