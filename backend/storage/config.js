import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function isAcquisitionWorkflow(operation,input={}) {
  return ["news.collect","news.supplemental","rss.fetch"].includes(operation) ||
    (operation==="domain.call" && input.service==="rss" && input.method==="refresh");
}
export function isPureRead(operation,input={}) {
  if(['agent.read','scenarios.prepare','runtime.load','storage.status'].includes(operation))return true;
  return operation==='domain.call' && ({news:['search','getItem','getHistory','coverage','getFeed','getLiveFeed'],candles:['query','latest','has','hasCandle'],awareness:['getSnapshot'],events:['search']}[input.service] || []).includes(input.method);
}
function integer(value, fallback, minimum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error("Invalid storage limit");
  return number;
}
export function storageConfig(overrides = {}, env = process.env) {
  const policy=RUNTIME_POLICY.storage;
  // Production always uses the durable SQL backend. Tests/maintenance select
  // infrastructure or legacy adapters through explicit constructor overrides.
  const enabled=overrides.enabled ?? (env.NODE_ENV !== "test" && policy.enabled);
  const businessEnabled=overrides.businessEnabled ?? (env.NODE_ENV !== "test" && policy.businessEnabled);
  return {
    enabled,
    analysisWorker:overrides.analysisWorker === true,
    readerRole:overrides.readerRole === "queries"?"queries":"analysis",
    isolateAnalysis:overrides.isolateAnalysis !== false,
    businessEnabled,
    maxInFlight:integer(overrides.maxInFlight,businessEnabled?policy.maxInFlight:1,1),
    maxCpuInFlight:integer(overrides.maxCpuInFlight,policy.maxCpuInFlight,1),
    databasePath:path.resolve(backendDir,overrides.databasePath || env.STORAGE_DB_PATH || "data/sqlite/ogid.sqlite"),
    queueMaxItems:integer(overrides.queueMaxItems,policy.queueMaxItems,1),
    queueMaxBytes:integer(overrides.queueMaxBytes,businessEnabled?policy.queueMaxBytes:8*1024*1024,1),
    maxCommandBytes:integer(overrides.maxCommandBytes,businessEnabled?policy.maxCommandBytes:256*1024,1),
    timeoutMs:integer(overrides.timeoutMs,policy.timeoutMs,1),
    queueTimeoutMs:integer(overrides.queueTimeoutMs,policy.queueTimeoutMs,1),
    startupTimeoutMs:integer(overrides.startupTimeoutMs,policy.startupTimeoutMs,1),
    shutdownTimeoutMs:integer(overrides.shutdownTimeoutMs,policy.shutdownTimeoutMs,1),
    busyTimeoutMs:integer(overrides.busyTimeoutMs,policy.busyTimeoutMs,0),
    // A tool's explicit default deadline takes precedence over application
    // profiles; an inherited worker map retains the owner's resolved profiles.
    commandTimeouts:{...(overrides.timeoutMs === undefined?policy.commandTimeouts:{}),...overrides.commandTimeouts},
    networkTimeoutMs:integer(overrides.networkTimeoutMs ?? overrides.timeoutMs,policy.networkTimeoutMs,1),
    migrationsDir:overrides.migrationsDir
  };
}

export function storageCommandTimeout(options,operation,input={}) {
  const key=operation === "domain.call" ? `${operation}:${input.service}:${input.method}` : operation;
  return options.commandTimeouts?.[key] ?? (operation === "domain.call" && ["run","import","refresh"].includes(input.method)
    ? options.networkTimeoutMs : options.timeoutMs);
}
