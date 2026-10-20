// Explicit activation prerequisite; never evicts another resident model.
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { ensureShadowModel } from "../services/agent/shadowModel.js";
import { loadAgentConfig } from "../services/agent/config.js";
const args=process.argv.slice(2), load=args.includes("--load-verified-model"), release=args.filter(v=>v.startsWith("--release-idle-model=")), paths=args.filter(v=>v!=="--load-verified-model" && !v.startsWith("--release-idle-model="));
if(paths.length>1 || paths.some(v=>v.startsWith("--")) || release.length>1 || (release.length&&!load))throw Error("Uso: node backend/scripts/agent-shadow-model.js [catalogo.json] [--load-verified-model [--release-idle-model=ALIAS]]");
const env={...dotenv.parse(readFileSync(new URL("../.env",import.meta.url))),...process.env};
try {
  const manifest=paths[0]?JSON.parse(readFileSync(paths[0])):loadAgentConfig(env).manifest;
  console.log(JSON.stringify(await ensureShadowModel({manifest,upstream:env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080/v1",apiKey:env.LLAMACPP_API_KEY,load,releaseIdleAlias:release[0]?.slice("--release-idle-model=".length)}),null,2));
} catch(e) { console.error(e.message);process.exitCode=1; }
