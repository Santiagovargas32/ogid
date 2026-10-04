import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IntelligenceStore } from "../services/intel/intelligenceStore.js";
import { EvidenceMemoryService } from "../services/intel/evidenceMemoryService.js";
import { buildEvidencePacket } from "../services/intel/evidencePacketBuilder.js";

const at = Date.parse("2026-10-04T10:00:00Z");
const article = { id: "news-a", title: "United States security report", url: "https://example.org/a",
  publishedAt: "2026-10-04T09:00:00Z", sourceId: "publisher", countries: ["US"],
  domains: ["geopolitical"], dataMode: "observed", excerpt: "First report." };

test("evidence survives restart, deduplicates polls, and preserves revisions at their availability time", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "ogid-evidence-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let now = at;
  const store = new IntelligenceStore({ rootDir, now: () => now });
  const memory = new EvidenceMemoryService({ store, now: () => now });
  await memory.capture([article, { ...article, synthetic: true }]);
  await memory.capture([article]);
  assert.equal(store.sequence, 1);
  const original = store.evidenceAt(new Date(now).toISOString())[0];
  now += 60000;
  await memory.capture([{ ...article, excerpt: "Corrected report." }]);
  assert.equal(store.evidenceAt(new Date(at).toISOString())[0].excerpt, "First report.");
  assert.equal(store.list("evidence")[0].firstSeenAt, original.firstSeenAt);
  const packet = { evidence: store.evidenceAt(new Date(now).toISOString()) };
  const hash = await store.savePacket(packet);
  const restored = new IntelligenceStore({ rootDir, now: () => now });
  await restored.ready;
  assert.equal(restored.status.healthy, true);
  assert.equal(restored.sequence, 2);
  assert.equal(restored.list("evidence")[0].excerpt, "Corrected report.");
  assert.deepEqual(await restored.readPacket(hash), packet);
  await writeFile(path.join(rootDir, "packets", `${hash}.json`), "{}");
  await assert.rejects(restored.readPacket(hash), /integrity/);
});

test("journal repairs a torn final line but rejects interior and checksum corruption", async (t) => {
  for (const corruption of ["tail", "interior", "checksum"]) {
    const rootDir = await mkdtemp(path.join(tmpdir(), "ogid-journal-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const store = new IntelligenceStore({ rootDir, now: () => at });
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.put("checkpoint", `job-${i}`, { i })));
    const file = path.join(rootDir, "journal", "2026-10-04.jsonl");
    const journal = await readFile(file, "utf8");
    if (corruption === "tail") await appendFile(file, '{"schemaVersion":');
    if (corruption === "interior") await writeFile(file, "{invalid}\n" + journal);
    if (corruption === "checksum") await writeFile(file, journal.replace('"i":0', '"i":99'));
    const restored = new IntelligenceStore({ rootDir, now: () => at });
    await restored.ready;
    if (corruption === "tail") {
      assert.equal(restored.status.healthy, true);
      assert.equal(restored.status.repairedTails, 1);
      assert.equal(restored.list("checkpoint").length, 12);
      await restored.put("checkpoint", "next", { i: 12 });
      const again = new IntelligenceStore({ rootDir, now: () => at });
      await again.ready;
      assert.equal(again.sequence, 13);
    } else {
      assert.equal(restored.status.healthy, false);
      await assert.rejects(restored.put("checkpoint", "next", {}));
    }
  }
});

test("packets exclude blocked/future evidence and honor headline-only policy", async () => {
  const store = new IntelligenceStore({ now: () => at });
  const memory = new EvidenceMemoryService({ store, now: () => at });
  await memory.capture([{ ...article, usagePolicy: "headline-only-link-out" }]);
  await memory.capture([{ ...article, id: "b", url: "https://example.org/b" }], { admissionState: "blocked" });
  await memory.capture([{ ...article, id: "c", url: "https://example.org/c", publishedAt: "2026-10-05T09:00:00Z" }]);
  const packet = buildEvidencePacket({ store, countryId: "US", asOf: new Date(at).toISOString() });
  assert.equal(packet.evidence.length, 1);
  assert.equal(packet.evidence[0].excerpt, null);
  assert.equal(packet.coverage.excluded.notAdmitted, 1);
  assert.equal(packet.coverage.excluded.futurePublication, 1);
});

test("memory retention removes old evidence but retains upcoming events", async () => {
  let now = at;
  const store = new IntelligenceStore({ now: () => now, retentionDays: 1 });
  const memory = new EvidenceMemoryService({ store, now: () => now });
  await memory.capture([article, { ...article, eventId: "event", scheduledAt: "2026-10-10T10:00:00Z" }]);
  now += 2 * 86400000;
  store.pruneMemory();
  assert.equal(store.list("evidence").length, 1);
  assert.equal(store.list("evidence")[0].kind, "awareness");
});
