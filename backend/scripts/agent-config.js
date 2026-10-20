import { readFileSync, writeFileSync } from "node:fs";
import { generateOpenCodeConfig } from "../services/agent/opencodeConfig.js";
const [manifestPath, toolsPath, outputPath, mcpNode, mcpEntry] =
  process.argv.slice(2);
if (!manifestPath || !toolsPath || !outputPath || !mcpNode || !mcpEntry)
  throw new Error(
    "Usage: agent-config manifest.json tools.json output.json /absolute/node /absolute/mcp-entry.js",
  );
const manifest = JSON.parse(readFileSync(manifestPath)),
  tools = JSON.parse(readFileSync(toolsPath));
const config = generateOpenCodeConfig({
  manifest,
  defaultModel: manifest.defaultModel,
  toolNames: tools,
  mcpCommand: [mcpNode, mcpEntry],
});
writeFileSync(outputPath, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
console.log("OpenCode v2 configuration validated and generated");
