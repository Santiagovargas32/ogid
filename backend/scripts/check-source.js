import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [backendDir, path.resolve(backendDir, "../frontend/js")];

function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "data") return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listJavaScriptFiles(target) : entry.name.endsWith(".js") ? [target] : [];
  });
}

for (const file of roots.flatMap(listJavaScriptFiles)) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log("Source syntax check passed.");
