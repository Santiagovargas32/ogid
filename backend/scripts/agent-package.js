// Reviewable staging bundle only: never installs services or copies .env/data.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  lstatSync,
} from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(fileURLToPath(new URL("../../", import.meta.url))),
  output = resolve(process.argv[2] || "");
const sourceTree = relative(root, output).split(/[\\/]/)[0];
if (
  !process.argv[2] ||
  output === root ||
  ["backend", "frontend", "integrations", ".git"].includes(sourceTree)
)
  throw Error("Use a new staging directory outside application source trees");
mkdirSync(output, { recursive: false, mode: 0o700 });
const candidates = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "backend",
    "frontend",
    "integrations/ogid-mcp",
  ],
  { cwd: root },
)
  .toString()
  .split("\0")
  .filter(Boolean);
const hashes = [];
for (const file of [...new Set(candidates)].sort()) {
  if (file.includes("/tests/") && !file.endsWith("/tests/testSetup.cjs"))
    continue;
  if (
    /(^|\/)(node_modules|data|\.git)(\/|$)/.test(file) ||
    (/\/\.env(?:\.|$)/.test(file) && !file.endsWith(".example"))
  )
    continue;
  if (
    file !== "integrations/ogid-mcp/API-MCP.md" &&
    !/\.(js|cjs|mjs|json|html|css|svg|png|jpg|jpeg|webp|ico|sql|example)$/.test(
      file,
    )
  )
    continue;
  const source = resolve(root, file);
  if (!source.startsWith(root) || !lstatSync(source).isFile()) continue;
  const bytes = readFileSync(source),
    target = resolve(output, "runtime", file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  hashes.push({
    file: relative(output, target),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const bundle = {
  schemaVersion: "ogid-agent-staging-v1",
  preparedAt: new Date().toISOString(),
  checkout: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim(),
  node: process.version,
  opencodeVersion: "2.0.31",
  files: hashes,
};
bundle.sha256 = createHash("sha256")
  .update(JSON.stringify(hashes))
  .digest("hex");
writeFileSync(
  resolve(output, "manifest.json"),
  JSON.stringify(bundle, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    output,
    files: hashes.length,
    sha256: bundle.sha256,
    installed: false,
  }),
);
