import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import dotenv from "dotenv";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v) => v.split(/=(.*)/s))
    .map(([k, v]) => [k, v || true]),
);
const env = {
  ...dotenv.parse(
    existsSync(new URL("../.env", import.meta.url))
      ? readFileSync(new URL("../.env", import.meta.url))
      : "",
  ),
  ...process.env,
};
const report = {
  schemaVersion: "ogid-agent-preflight-v1",
  checkedAt: new Date().toISOString(),
  node: process.version,
  checks: [],
  limitations: [],
  ready: false,
};
function command(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
report.checkout = command("git", ["rev-parse", "HEAD"]);
const opencodeBinary = resolve(fileURLToPath(new URL("../",import.meta.url)),env.AGENT_OPENCODE_BINARY || env.OGID_OPENCODE_BINARY || "data/agent-runtime/bin/opencode");
report.opencode = command(opencodeBinary,["--version"]);
report.binaries = {
  node: {
    version: process.version,
    sha256: hash(readFileSync(process.execPath)),
  },
  opencode: {
    version: report.opencode,
    sha256: existsSync(opencodeBinary)
      ? hash(readFileSync(opencodeBinary))
      : null,
  },
};
report.runtime = { mode:"terminal", entrypoint:"cd backend && npm start", switches:Object.fromEntries(["AGENT_BROKER_ENABLED","AGENT_OPENCODE_ENABLED","AGENT_WORKER_ENABLED"].map(key=>[key,env[key] || "off"])) };
report.host = { node:process.version, storageMount:command("findmnt",["-no","SOURCE,FSTYPE,TARGET","--target","/srv/bitcoin"]) };
try {
  const db=new Database(":memory:");db.close();report.host.nativeBinding={ready:true};
} catch { report.host.nativeBinding={ready:false,code:"NATIVE_BINDING_UNAVAILABLE"};report.limitations.push("Native SQLite binding unavailable for the terminal Node."); }
try {
  const response=await fetch(`http://127.0.0.1:${env.PORT || "3000"}/api/agent/v1/capabilities`,{signal:AbortSignal.timeout(5000),redirect:"error"});
  const value=await response.json();report.runtime.http=response.status;report.runtime.components=value.data?.runtime?.components || null;
} catch { report.limitations.push("Terminal backend unavailable; start it with cd backend && npm start."); }
const ini = String(options["--ini"] || "/etc/llama-server/models.ini");
if (existsSync(ini)) {
  const text = readFileSync(ini, "utf8");
  report.presetHash = hash(text);
  report.presetPath = ini;
  report.presets = [];
  let section;
  for (const line of text.split(/\r?\n/)) {
    const title = line.match(/^\s*\[([^\]]+)\]/);
    if (title) {
      section = { alias: title[1], settings: {} };
      report.presets.push(section);
      continue;
    }
    const value = line.match(
      /^\s*(ctx-size|parallel|kv-unified-per-slot|preset)\s*=\s*([^;#]*)/,
    );
    if (section && value) section.settings[value[1]] = value[2].trim();
  }
} else
  report.limitations.push(
    "Preset INI unavailable; do not infer desired context.",
  );
if (env.STORAGE_DB_PATH && existsSync(env.STORAGE_DB_PATH)) {
  const db = new Database(env.STORAGE_DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only=ON");
    report.storage = {
      migrations: db
        .prepare(
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        )
        .all(),
      writer: db
        .prepare("SELECT process_id AS pid FROM storage_writer_owner")
        .get(),
    };
    for (const m of report.storage.migrations) {
      const path = new URL(`../storage/migrations/${m.name}`, import.meta.url);
      if (!existsSync(path) || hash(readFileSync(path)) !== m.checksum)
        report.limitations.push(
          `Migration ${m.version} checksum mismatch; no automatic repair.`,
        );
    }
  } finally {
    db.close();
  }
}
const base = new URL(env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080/v1"),
  headers = { Authorization: `Bearer ${env.LLAMACPP_API_KEY || ""}` };
try {
  const r = await fetch(new URL("/models", base), {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  const d = await r.json();
  report.models = [];
  for (const m of d.data || []) {
    const row = {
      alias: m.id,
      state: "context-unverified",
      resident: m.status?.value === "loaded",
      context: null,
    };
    if (row.resident) {
      const p = await fetch(
        new URL(
          `/props?model=${encodeURIComponent(m.id)}&autoload=false`,
          base,
        ),
        { headers, signal: AbortSignal.timeout(10000) },
      );
      if (p.ok) {
        const props = await p.json();
        row.context = props.default_generation_settings?.n_ctx || null;
        row.slots = props.total_slots;
        row.serverBuild = props.build_info;
        row.defaultOutput =
          props.default_generation_settings?.params?.n_predict ?? null;
      }
    }
    report.models.push(row);
  }
  report.checks.push("Authenticated model inventory without autoload");
  if (report.presets) {
    const defaults =
      report.presets.find((p) => p.alias === "*")?.settings || {};
    report.presetComparison = report.models.map((m) => {
      const preset = report.presets.find((p) => p.alias === m.alias);
      const settings = { ...defaults, ...preset?.settings };
      const configuredContext = Number(settings["ctx-size"]) || null;
      const configuredSlots = Number(settings.parallel) || null;
      const comparison = !preset
        ? "alias-missing"
        : !m.resident
          ? "not-loaded"
          : configuredContext === m.context && configuredSlots === m.slots
            ? "matches-resident"
            : "mismatch";
      if (["alias-missing", "mismatch"].includes(comparison))
        report.limitations.push(`Preset comparison ${comparison}: ${m.alias}`);
      return { alias: m.alias, configuredContext, configuredSlots, comparison };
    });
  }
} catch {
  report.limitations.push("Authenticated llama.cpp inventory unavailable.");
}
report.limitations.push(
  "Run npm run smoke:agent to verify terminal-managed OpenCode/MCP/inference/publication. Preflight alone does not authorize visibility.",
);
const output = options["--output"];
if (output)
  writeFileSync(String(output), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
else console.log(JSON.stringify(report, null, 2));
