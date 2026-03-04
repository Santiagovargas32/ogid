import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSentiment } from "../utils/sentimentRules.js";

test("analyzeSentiment marks negative text as negative", () => {
  const result = analyzeSentiment("Missile attack and military operation caused crisis and unrest.");
  assert.equal(result.label, "negative");
  assert.ok(result.negativeHits > result.positiveHits);
});

test("analyzeSentiment marks cooperative language as positive", () => {
  const result = analyzeSentiment("Ceasefire dialogue and diplomatic breakthrough support peace.");
  assert.equal(result.label, "positive");
  assert.ok(result.positiveHits > result.negativeHits);
});
