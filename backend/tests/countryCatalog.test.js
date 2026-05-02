import test from "node:test";
import assert from "node:assert/strict";
import { detectCountryMentions } from "../utils/countryCatalog.js";

test("detectCountryMentions finds countries from aliases and names", () => {
  const mentions = detectCountryMentions(
    "Officials in Kyiv said Ukraine expects consultations with Washington and Tehran."
  );

  assert.ok(mentions.includes("UA"));
  assert.ok(mentions.includes("US"));
  assert.ok(mentions.includes("IR"));
});

test("detectCountryMentions supports Colombia", () => {
  const mentions = detectCountryMentions("Security officials in Bogota reviewed Colombia border operations.");

  assert.ok(mentions.includes("CO"));
});
