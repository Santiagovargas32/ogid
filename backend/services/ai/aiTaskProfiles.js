// Plan sections 7 and 10: task-sized responses within the existing server context.
export const AI_TASK_PROFILES = Object.freeze({
  article_summary: { maxOutputTokens: 1536, temperature: 0.3, thinking: false },
  country_insight: { maxOutputTokens: 4096, temperature: 0.5, thinking: false },
  market_explanation: { maxOutputTokens: 3072, temperature: 0.3, thinking: false },
  market_scenarios: { maxOutputTokens: 6144, temperature: 0.7, thinking: false },
  event_scenarios: { maxOutputTokens: 4096, temperature: 0.5, thinking: false }
});

export function readTaskProfiles(value = "") {
  const overrides = typeof value === "string" ? (value.trim() ? JSON.parse(value) : {}) : value;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("AI_TASK_OUTPUT_TOKENS must be a JSON object.");
  for (const [kind, tokens] of Object.entries(overrides)) {
    if (!(kind in AI_TASK_PROFILES) || !Number.isInteger(tokens) || tokens < 256 || tokens > 32768) {
      throw new Error("AI_TASK_OUTPUT_TOKENS requires known task names and integer limits from 256 to 32768.");
    }
  }
  return Object.fromEntries(Object.entries(AI_TASK_PROFILES).map(([kind, profile]) => [kind, {
    ...profile, maxOutputTokens: overrides[kind] ?? profile.maxOutputTokens,
    topP: 0.8, topK: 20, minP: 0, version: "ogid-local-tasks-v1"
  }]));
}
