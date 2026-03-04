import test from "node:test";
import assert from "node:assert/strict";
import { extractConflictSignal } from "../utils/conflictTags.js";

test("extractConflictSignal returns weighted tags for conflict text", () => {
  const signal = extractConflictSignal(
    "Military offensive included missile strikes and triggered humanitarian aid shortage concerns."
  );

  assert.ok(signal.totalWeight > 0);
  assert.ok(signal.tags.some((item) => item.tag === "Military"));
  assert.ok(signal.tags.some((item) => item.tag === "Humanitarian Crisis"));
});
