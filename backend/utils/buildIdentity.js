import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { OPERATIONS_VERSION } from "../contracts/ogidOperations.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
function git(args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim(); } catch { return null; } }
// Capturado una sola vez al importar, nunca recalculado desde un checkout mutable al consultar health.
export function captureBuildIdentity(component, version) {
  const checkoutCommitAtStart = git(["rev-parse", "HEAD"]); const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  const digest = createHash("sha256");
  function scan(dir) { for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(relative);
    else if (entry.isFile() && /\.(js|json)$/.test(entry.name)) { digest.update(relative); digest.update(readFileSync(path.join(root, relative))); }
  } }
  let artifactHash = null;
  try { for (const dir of component === "backend" ? ["backend/contracts", "backend/controllers", "backend/middleware", "backend/routes", "backend/services", "backend/state", "backend/utils"] : ["integrations/ogid-mcp/src", "backend/contracts", "backend/utils"]) scan(dir);
    if (component === "backend") digest.update(readFileSync(path.join(root, "backend/server.js"))); artifactHash = digest.digest("hex");
  } catch { /* Un artefacto incompleto no acredita identidad. */ }
  const declared = process.env.OGID_BUILD_COMMIT;
  const buildCommit = /^[a-f0-9]{40,64}$/.test(declared || "") ? declared : null;
  return Object.freeze({ component, version, contractVersion: OPERATIONS_VERSION, capturedAt: new Date().toISOString(),
    checkoutCommitAtStart, buildCommit, buildTime: Number.isFinite(Date.parse(process.env.OGID_BUILD_TIME || "")) ? new Date(process.env.OGID_BUILD_TIME).toISOString() : null,
    dirty: status === null ? "unknown" : Boolean(status), artifactHash, hashAlgorithm: "sha256", verification: artifactHash ? "startup-files-hashed" : "unknown",
    declaredCommitMatchesCheckout: buildCommit && checkoutCommitAtStart ? buildCommit === checkoutCommitAtStart : null,
    runningCommitVerified: false, attestation: "local-startup-observation; declared build metadata is not cryptographic attestation" });
}
export const BACKEND_BUILD = captureBuildIdentity("backend", "1.0.0");
