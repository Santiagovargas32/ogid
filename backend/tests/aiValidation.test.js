import test from "node:test";
import assert from "node:assert/strict";
import { getAiOutputSchema, validateAiOutput } from "../services/ai/aiSchemas.js";

const ARTICLE_ID = "ca_1234567890abcdef";

function validArticleOutput() {
  return {
    summary: "The report describes a verified disruption.",
    summaryEvidenceArticleIds: [ARTICLE_ID],
    keyDevelopments: [{ text: "A disruption was reported.", evidenceArticleIds: [ARTICLE_ID] }],
    entities: [{ name: "Example Energy", type: "organization", evidenceArticleIds: [ARTICLE_ID] }],
    uncertainty: { level: "medium", notes: ["Only one report is supplied."] }
  };
}

test("strict article schema and grounding accept supported output", () => {
  const result = validateAiOutput("article_summary", validArticleOutput(), {
    allowedArticleIds: [ARTICLE_ID],
    evidenceText: "Example Energy reported a disruption."
  });
  assert.equal(result.valid, true);
  assert.equal(getAiOutputSchema("article_summary").additionalProperties, false);
});

test("unknown references and entities are rejected atomically", () => {
  const output = validArticleOutput();
  output.summaryEvidenceArticleIds = ["ca_unknown"];
  output.entities[0].name = "Invented Entity";
  const result = validateAiOutput("article_summary", output, {
    allowedArticleIds: [ARTICLE_ID],
    evidenceText: "Example Energy reported a disruption."
  });
  assert.equal(result.valid, false);
  assert.ok(result.codes.includes("UNKNOWN_EVIDENCE_ARTICLE"));
  assert.ok(result.codes.includes("ENTITY_NOT_IN_EVIDENCE"));
});

test("extra fields fail strict JSON validation", () => {
  const result = validateAiOutput("article_summary", { ...validArticleOutput(), confidence: 0.9 }, {
    allowedArticleIds: [ARTICLE_ID],
    evidenceText: "Example Energy"
  });
  assert.equal(result.schemaValid, false);
  assert.ok(result.codes.includes("SCHEMA_ADDITIONALPROPERTIES"));
});

test("market recommendations and causal claims are rejected", () => {
  const output = {
    instrumentId: "us-equity-example",
    narrative: "Investors should buy because the report caused the move.",
    narrativeEvidenceArticleIds: [ARTICLE_ID],
    drivers: [],
    causality: "not_established",
    limitations: ["Association only."],
    uncertainty: { level: "high", notes: [] }
  };
  const result = validateAiOutput("market_explanation", output, {
    allowedArticleIds: [ARTICLE_ID],
    instrumentId: "us-equity-example"
  });
  assert.equal(result.valid, false);
  assert.ok(result.codes.includes("MARKET_RECOMMENDATION_FORBIDDEN"));
  assert.ok(result.codes.includes("MARKET_CAUSAL_CLAIM_FORBIDDEN"));
});
