import { computeMarketImpact } from './impactEngineService.js';
import { generatePredictions } from './predictionEngineService.js';
import { generateInsights } from '../insightService.js';
export function calculateMarketProjection(input) {
  const predictions=generatePredictions(input);
  const impact=computeMarketImpact({...input,predictionScores:predictions.predictionScoreByTicker || {}});
  const insights=generateInsights({countries:input.countries,previousCountries:input.countries,inputMode:input.inputMode});
  return {predictions,impact,insights};
}
