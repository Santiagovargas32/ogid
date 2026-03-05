import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBandByProviderSnapshots,
  resolveNewsPolicy,
  resolveQuotaBandFromSnapshot
} from "../services/refreshPolicyService.js";

test("resolveQuotaBandFromSnapshot maps ratio thresholds", () => {
  assert.equal(
    resolveQuotaBandFromSnapshot({
      effectiveRemaining: 90,
      configuredLimit: 100
    }),
    "GREEN"
  );
  assert.equal(
    resolveQuotaBandFromSnapshot({
      effectiveRemaining: 20,
      configuredLimit: 100
    }),
    "YELLOW"
  );
  assert.equal(
    resolveQuotaBandFromSnapshot({
      effectiveRemaining: 10,
      configuredLimit: 100
    }),
    "RED"
  );
  assert.equal(
    resolveQuotaBandFromSnapshot({
      effectiveRemaining: 4,
      configuredLimit: 100
    }),
    "CRITICAL"
  );
});

test("resolveBandByProviderSnapshots keeps worst band", () => {
  const band = resolveBandByProviderSnapshots([
    { effectiveRemaining: 60, configuredLimit: 100 },
    { effectiveRemaining: 3, configuredLimit: 100 }
  ]);
  assert.equal(band, "CRITICAL");
});

test("resolveNewsPolicy returns interval and page size for worst provider band", () => {
  const policy = resolveNewsPolicy({
    providerSnapshots: [
      { effectiveRemaining: 50, configuredLimit: 100 },
      { effectiveRemaining: 12, configuredLimit: 100 }
    ],
    intervalByBandMs: {
      GREEN: 600_000,
      YELLOW: 1_200_000,
      RED: 2_700_000,
      CRITICAL: 7_200_000
    },
    pageSizeByBand: {
      GREEN: 100,
      YELLOW: 75,
      RED: 40,
      CRITICAL: 20
    }
  });

  assert.equal(policy.band, "RED");
  assert.equal(policy.intervalMs, 2_700_000);
  assert.equal(policy.pageSize, 40);
});

