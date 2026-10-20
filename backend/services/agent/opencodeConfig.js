import {catalogModel} from "./modelCatalog.js";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { ANALYST_SYSTEM, agentError } from "./contracts.js";
import { readyModel, localUrl } from "./config.js";
const api = JSON.parse(
  readFileSync(
    new URL("./compat/opencode-2.0.31.openapi.json", import.meta.url),
  ),
);
const ajv = new Ajv({ strict: false, validateFormats: false });
const validate = ajv.compile({
  $ref: "#/components/schemas/Config.InfoEncoded",
  components: api.components,
});
export function generateOpenCodeConfig({
  manifest,
  brokerUrl = "http://127.0.0.1:4097",
  mcpCommand,
  toolNames,
  defaultModel,
}) {
  if (
    !Array.isArray(toolNames) ||
    !toolNames.length ||
    toolNames.some(
      (t) => !/^ogid_read_ogid_(query|get_capabilities|health)$/.test(t),
    )
  )
    throw agentError("OPENCODE_TOOL_ALLOWLIST_REQUIRED");
  if (!Array.isArray(mcpCommand) || !mcpCommand.length)
    throw agentError("OPENCODE_MCP_COMMAND_REQUIRED");
  const models = manifest.models.filter(catalogModel);
  const selected = models.find((m) => `llamacpp/${m.alias}` === defaultModel);
  if (!selected) throw agentError("OPENCODE_MODEL_UNVERIFIED");
  const compactionContext = Math.min(...models.map((m) => m.context));
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...toolNames.map((action) => ({ action, resource: "*", effect: "allow" })),
  ];
  const config = {
    $schema: "https://opencode.ai/v2/config.json",
    model: defaultModel,
    default_agent: "ogid-analyst",
    update: "disable",
    share: "disabled",
    snapshots: false,
    formatter: false,
    lsp: false,
    websearch: false,
    plugins: [],
    skills: [],
    instructions: [],
    permissions,
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "llamacpp", effect: "allow" },
    ],
    providers: {
      llamacpp: {
        name: "OGID local inference",
        package: "@ai-sdk/openai-compatible",
        settings: {
          baseURL: localUrl(brokerUrl).origin + "/v1",
          apiKey: "{env:AGENT_BROKER_TOKEN}",
          timeout: false,
        },
        models: Object.fromEntries(
          models.map((m) => [
            m.alias,
            {
              name: m.alias,
              limit: { context: m.context },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
            },
          ]),
        ),
      },
    },
    agents: {
      "ogid-analyst": {
        description: "Analista OGID de lectura",
        mode: "primary",
        system: ANALYST_SYSTEM,
        permissions,
        request: { headers: { "x-ogid-work-class": "background" } },
      },
      "ogid-analyst-chat": {
        description: "Mismo analista OGID en sesiones de chat",
        mode: "primary",
        system: ANALYST_SYSTEM,
        permissions,
        request: { headers: { "x-ogid-work-class": "chat" } },
      },
      "ogid-analyst-alert": {
        description: "Mismo analista OGID para alertas prioritarias",
        mode: "primary",
        system: ANALYST_SYSTEM,
        permissions,
        request: { headers: { "x-ogid-work-class": "critical" } },
      },
      build: { disabled: true },
      general: { disabled: true },
      explore: { disabled: true },
      plan: { disabled: true },
    },
    compaction: {
      auto: true,
      keep: { tokens: Math.floor(compactionContext / 8) },
      buffer: Math.floor(compactionContext / 8),
    },
    mcp: {
      servers: {
        ogid_read: {
          type: "local",
          command: mcpCommand,
          environment: {
            OGID_PROFILE: "research",
            OGID_RESEARCH_SCOPE: "agent-evidence",
            OGID_INSTRUMENT_AUTH: "runtime",
          },
          protocol: "legacy",
          codemode: false,
          timeout: { execution: 200000 },
        },
      },
    },
  };
  if (!validate(config)) throw agentError("OPENCODE_CONFIG_SCHEMA_INVALID");
  return config;
}
export function validateOpenCodeConfig(value) {
  return validate(value);
}
