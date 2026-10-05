import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const config = loadConfig();
  const handle = serveStdio(() => createServer(config));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void handle.close(); });
} catch {
  console.error("No se pudo iniciar OGID MCP: revisar la configuración local y las dependencias.");
  process.exitCode = 1;
}
