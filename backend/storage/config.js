import path from "node:path";
import { fileURLToPath } from "node:url";
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function integer(value, fallback, minimum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error("Invalid storage limit");
  return number;
}
export function storageConfig(overrides = {}, env = process.env) {
  const enabled = overrides.enabled ?? (env.STORAGE_ENABLED === "1");
  return {
    enabled,
    businessEnabled: overrides.businessEnabled ?? (env.STORAGE_BUSINESS_ENABLED === "1"),
    maxInFlight: integer(overrides.maxInFlight, (overrides.businessEnabled ?? (env.STORAGE_BUSINESS_ENABLED === "1")) ? 8 : 1, 1),
    maxCpuInFlight: integer(overrides.maxCpuInFlight, 1, 1),
    databasePath: path.resolve(backendDir, overrides.databasePath || env.STORAGE_DB_PATH || "data/sqlite/ogid.sqlite"),
    queueMaxItems: integer(overrides.queueMaxItems ?? env.STORAGE_QUEUE_MAX_ITEMS, 128, 1),
    queueMaxBytes: integer(overrides.queueMaxBytes ?? env.STORAGE_QUEUE_MAX_BYTES, (overrides.businessEnabled ?? (env.STORAGE_BUSINESS_ENABLED === "1")) ? 32 * 1024 * 1024 : 8 * 1024 * 1024, 1),
    maxCommandBytes: integer(overrides.maxCommandBytes ?? env.STORAGE_MAX_COMMAND_BYTES, (overrides.businessEnabled ?? (env.STORAGE_BUSINESS_ENABLED === "1")) ? 8 * 1024 * 1024 : 256 * 1024, 1),
    timeoutMs: integer(overrides.timeoutMs ?? env.STORAGE_TIMEOUT_MS, 15000, 1),
    queueTimeoutMs: integer(overrides.queueTimeoutMs ?? env.STORAGE_QUEUE_TIMEOUT_MS, (overrides.businessEnabled ?? (env.STORAGE_BUSINESS_ENABLED === "1")) ? 90000 : 15000, 1),
    startupTimeoutMs: integer(overrides.startupTimeoutMs, 30000, 1),
    shutdownTimeoutMs: integer(overrides.shutdownTimeoutMs ?? env.STORAGE_SHUTDOWN_TIMEOUT_MS, 30000, 1),
    busyTimeoutMs: integer(overrides.busyTimeoutMs, 2000, 0),
    migrationsDir: overrides.migrationsDir
  };
}
