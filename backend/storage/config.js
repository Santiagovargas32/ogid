import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
import { storageOperationContract } from '../contracts/storageOperations.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function storageWorkClass(operation,input={}){
  return storageOperationContract(operation,input).workClass;
}
export function isAcquisitionWorkflow(operation,input={}) {
  return storageOperationContract(operation,input).acquisition;
}
export function isPureRead(operation,input={}) {
  return storageOperationContract(operation,input).pureRead;
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
    checkpointSoftBytes:integer(overrides.checkpointSoftBytes,policy.checkpointSoftBytes,1),
    checkpointHardBytes:integer(overrides.checkpointHardBytes,policy.checkpointHardBytes,1),
    checkpointTimeoutMs:integer(overrides.checkpointTimeoutMs,policy.maintenanceTimeoutMs,1),
    // A tool's explicit default deadline takes precedence over application
    // profiles; an inherited worker map retains the owner's resolved profiles.
    commandTimeouts:{...(overrides.timeoutMs === undefined?policy.commandTimeouts:{}),...overrides.commandTimeouts},
    networkTimeoutMs:integer(overrides.networkTimeoutMs ?? overrides.timeoutMs,policy.networkTimeoutMs,1),
    migrationsDir:overrides.migrationsDir
  };
}

export function storageCommandTimeout(options,operation,input={}) {
  if(operation==='agent.call' && input.method==='heartbeat')return Math.min(5000,options.timeoutMs);
  const key=operation === "domain.call" ? `${operation}:${input.service}:${input.method}` : operation;
  return options.commandTimeouts?.[key] ?? (operation === "domain.call" && ["run","import","refresh"].includes(input.method)
    ? options.networkTimeoutMs : options.timeoutMs);
}
