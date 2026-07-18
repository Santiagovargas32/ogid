import assert from "node:assert/strict";
import test from "node:test";
import {
  addMarketInstrument,
  marketSelectionIds,
  marketSelectionSymbols,
  removeMarketInstrument,
  resolveSelectedMarketInstruments,
  validateMarketSelection
} from "../../frontend/js/marketWatchlistModel.js";

const gd = { instrumentId: "us-equity-general-dynamics", symbol: "gd", displayName: "General Dynamics" };
const ba = { instrumentId: "us-equity-boeing", symbol: "BA", displayName: "Boeing" };

test("dynamic watchlist resolves selected-only and legacy flagged payloads", () => {
  assert.deepEqual(marketSelectionSymbols(resolveSelectedMarketInstruments({ instruments: [gd, ba] })), ["GD", "BA"]);
  assert.deepEqual(
    marketSelectionIds(resolveSelectedMarketInstruments({ instruments: [{ ...gd, selected: false }, { ...ba, selected: true }] })),
    [ba.instrumentId]
  );
});

test("dynamic watchlist deduplicates, supports an unlimited default and removal", () => {
  const first = addMarketInstrument([], gd);
  assert.equal(first.changed, true);
  assert.equal(addMarketInstrument(first.instruments, gd).reason, null);
  const second = addMarketInstrument(first.instruments, ba);
  assert.equal(second.changed, true);
  assert.deepEqual(validateMarketSelection(second.instruments), { valid: true, reason: null, count: 2 });
  const eight = Array.from({ length: 6 }, (_, index) => ({ instrumentId: `dynamic-${index}`, symbol: `DYN${index}` }))
    .reduce((selection, instrument) => addMarketInstrument(selection, instrument).instruments, second.instruments);
  assert.deepEqual(validateMarketSelection(eight), { valid: true, reason: null, count: 8 });

  const removed = removeMarketInstrument(first.instruments, gd.instrumentId);
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.instruments, []);
  assert.deepEqual(validateMarketSelection(removed.instruments, 1), { valid: true, reason: null, count: 0 });
});

test("dynamic watchlist retains an explicit optional maximum", () => {
  const first = addMarketInstrument([], gd, 1);
  assert.equal(addMarketInstrument(first.instruments, ba, 1).reason, "limit");
  assert.deepEqual(validateMarketSelection([gd, ba], 1), { valid: false, reason: "limit", count: 2 });
});
