import Ajv from "ajv";

const evidenceIds = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
  items: { type: "string", minLength: 4, maxLength: 80 }
};

const uncertainty = {
  type: "object",
  additionalProperties: false,
  required: ["level", "notes"],
  properties: {
    level: { enum: ["low", "medium", "high"] },
    notes: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 300 }
    }
  }
};

const claim = {
  type: "object",
  additionalProperties: false,
  required: ["text", "evidenceArticleIds"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 500 },
    evidenceArticleIds: evidenceIds
  }
};

export const AI_OUTPUT_SCHEMAS = Object.freeze({
  article_summary: {
    $id: "ogid-ai-article-summary-v1",
    type: "object",
    additionalProperties: false,
    required: ["summary", "summaryEvidenceArticleIds", "keyDevelopments", "entities", "uncertainty"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 1_200 },
      summaryEvidenceArticleIds: evidenceIds,
      keyDevelopments: { type: "array", maxItems: 8, items: claim },
      entities: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "evidenceArticleIds"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 160 },
            type: { enum: ["person", "organization", "location", "instrument", "date", "other"] },
            evidenceArticleIds: evidenceIds
          }
        }
      },
      uncertainty
    }
  },
  country_insight: {
    $id: "ogid-ai-country-insight-v1",
    type: "object",
    additionalProperties: false,
    required: ["countryId", "overview", "overviewEvidenceArticleIds", "developments", "scenarios", "informationGaps", "uncertainty"],
    properties: {
      countryId: { type: "string", pattern: "^[A-Z]{2}$" },
      overview: { type: "string", minLength: 1, maxLength: 1_200 },
      overviewEvidenceArticleIds: evidenceIds,
      developments: { type: "array", maxItems: 10, items: claim },
      scenarios: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "likelihood", "evidenceArticleIds"],
          properties: {
            description: { type: "string", minLength: 1, maxLength: 500 },
            likelihood: { enum: ["low", "medium", "high", "unknown"] },
            evidenceArticleIds: evidenceIds
          }
        }
      },
      informationGaps: {
        type: "array",
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 300 }
      },
      uncertainty
    }
  },
  market_explanation: {
    $id: "ogid-ai-market-explanation-v1",
    type: "object",
    additionalProperties: false,
    required: ["instrumentId", "narrative", "narrativeEvidenceArticleIds", "drivers", "causality", "limitations", "uncertainty"],
    properties: {
      instrumentId: { type: "string", minLength: 2, maxLength: 160 },
      narrative: { type: "string", minLength: 1, maxLength: 1_200 },
      narrativeEvidenceArticleIds: evidenceIds,
      drivers: { type: "array", maxItems: 8, items: claim },
      causality: { const: "not_established" },
      limitations: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 300 }
      },
      uncertainty
    }
  }
});

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  Object.entries(AI_OUTPUT_SCHEMAS).map(([kind, schema]) => [kind, ajv.compile(schema)])
);

function collectEvidenceReferences(kind, output = {}) {
  if (kind === "article_summary") {
    return [
      ...(output.summaryEvidenceArticleIds || []),
      ...(output.keyDevelopments || []).flatMap((item) => item.evidenceArticleIds || []),
      ...(output.entities || []).flatMap((item) => item.evidenceArticleIds || [])
    ];
  }
  if (kind === "country_insight") {
    return [
      ...(output.overviewEvidenceArticleIds || []),
      ...(output.developments || []).flatMap((item) => item.evidenceArticleIds || []),
      ...(output.scenarios || []).flatMap((item) => item.evidenceArticleIds || [])
    ];
  }
  return [
    ...(output.narrativeEvidenceArticleIds || []),
    ...(output.drivers || []).flatMap((item) => item.evidenceArticleIds || [])
  ];
}

function normalizeEvidenceText(value = "") {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function marketPolicyErrors(output = {}) {
  const text = [output.narrative, ...(output.drivers || []).map((item) => item.text)].join(" ");
  const errors = [];
  if (/\b(buy|sell|hold|go long|go short|price target|target price|should invest|recommend(?:ed|ation)?)\b/i.test(text)) {
    errors.push("MARKET_RECOMMENDATION_FORBIDDEN");
  }
  if (/\b(caused|causes|will cause|directly led to|is responsible for)\b/i.test(text)) {
    errors.push("MARKET_CAUSAL_CLAIM_FORBIDDEN");
  }
  return errors;
}

export function getAiOutputSchema(kind) {
  return AI_OUTPUT_SCHEMAS[kind] || null;
}

export function validateAiOutput(kind, output, context = {}) {
  const validator = validators[kind];
  if (!validator) return { valid: false, schemaValid: false, groundingValid: false, codes: ["UNSUPPORTED_AI_KIND"] };
  const schemaValid = validator(output);
  const codes = schemaValid
    ? []
    : (validator.errors || []).map((error) => `SCHEMA_${String(error.keyword || "INVALID").toUpperCase()}`);

  if (schemaValid) {
    const allowedIds = new Set(context.allowedArticleIds || []);
    for (const articleId of collectEvidenceReferences(kind, output)) {
      if (!allowedIds.has(articleId)) codes.push("UNKNOWN_EVIDENCE_ARTICLE");
    }
    if (kind === "article_summary") {
      const evidenceText = normalizeEvidenceText(context.evidenceText);
      for (const entity of output.entities || []) {
        if (!evidenceText.includes(normalizeEvidenceText(entity.name))) codes.push("ENTITY_NOT_IN_EVIDENCE");
      }
    }
    if (kind === "country_insight" && output.countryId !== context.countryId) codes.push("COUNTRY_SUBJECT_MISMATCH");
    if (kind === "market_explanation" && output.instrumentId !== context.instrumentId) codes.push("INSTRUMENT_SUBJECT_MISMATCH");
    if (kind === "market_explanation") codes.push(...marketPolicyErrors(output));
  }

  const uniqueCodes = [...new Set(codes)];
  return {
    valid: schemaValid && uniqueCodes.length === 0,
    schemaValid: Boolean(schemaValid),
    groundingValid: Boolean(schemaValid) && uniqueCodes.length === 0,
    codes: uniqueCodes
  };
}
