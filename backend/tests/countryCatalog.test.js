import test from "node:test";
import assert from "node:assert/strict";
import { BASELINE_COUNTRIES, COUNTRY_CATALOG, detectCountryMentions, getCountryByIso2 } from "../utils/countryCatalog.js";

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

test("country catalog covers map seed countries and detects their unambiguous aliases", () => {
  const requiredCodes = ["AE", "NL", "GB", "SA", "CD", "AR", "BO", "CL", "EG", "DE", "SG", "JO", "KW", "BH", "OM", "DJ", "IT", "MY", "ID", "PA", "KZ"];
  const supportedCodes = new Set(COUNTRY_CATALOG.map((country) => country.iso2));

  assert.equal(BASELINE_COUNTRIES.length, 21);

  requiredCodes.forEach((iso2) => {
    assert.ok(supportedCodes.has(iso2), `${iso2} should be supported`);
    assert.equal(getCountryByIso2(iso2)?.iso2, iso2);
  });

  const mentions = detectCountryMentions(
    "Jebel Ali and Ras Tanura reported changes while Rotterdam, Heathrow, Katanga, Suez and the Lithium Triangle were monitored."
  );
  ["AE", "SA", "NL", "GB", "CD", "AR", "BO", "CL", "EG"].forEach((iso2) => assert.ok(mentions.includes(iso2)));
});

test("ambiguous person and nationality aliases do not create country claims", () => {
  assert.equal(detectCountryMentions("Michael Jordan discussed the market outlook.").includes("JO"), false);
  assert.equal(detectCountryMentions("A Jordanian statement was issued in Amman.").includes("JO"), true);
  assert.equal(detectCountryMentions("Congolese officials met abroad.").includes("CD"), false);
  assert.equal(detectCountryMentions("Officials in the Democratic Republic of the Congo met in Kinshasa.").includes("CD"), true);
});
