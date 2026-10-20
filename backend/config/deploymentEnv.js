// Installation settings only. Operational limits belong to runtimePolicy.js.
export const DEPLOYMENT_ENV_KEYS = Object.freeze([
  "AGENT_MODE", "AGENT_TASK_MODES", "AGENT_MODEL_MANIFEST", "AGENT_BACKGROUND_MODEL", "AGENT_WORKER_TOKEN", "AGENT_BROKER_TOKEN", "AGENT_BROKER_URL",
  "OGID_OPENCODE_URL", "OGID_OPENCODE_PASSWORD", "OGID_INTERNAL_URL", "OGID_PUBLIC_ORIGIN",
  "AGENT_BROKER_ENABLED", "AGENT_OPENCODE_ENABLED", "AGENT_WORKER_ENABLED", "AGENT_RUNTIME_DIR", "AGENT_OPENCODE_BINARY",
  "NODE_ENV",
  "PORT",
  "HOST",
  "LOG_LEVEL",
  "ADMIN_API_TOKEN",
  "ALLOW_LOCAL_ADMIN",
  "ALLOW_LAN_ADMIN",
  "WS_TRUSTED_PROXY_IPS",
  "WS_ALLOWED_ORIGINS",
  "NEWS_PROVIDERS",
  "NEWS_API_KEY",
  "NEWS_API_BASE_URL",
  "GNEWS_API_KEY",
  "GNEWS_BASE_URL",
  "MEDIASTACK_API_KEY",
  "MEDIASTACK_BASE_URL",
  "GDELT_BASE_URL",
  "NEWS_RSS_FEEDS",
  "NEWS_RSS_DISABLED_FEEDS",
  "NEWS_RSS_CANONICAL_STATE_FILE",
  "AWARENESS_MODE",
  "AWARENESS_USER_AGENT",
  "AWARENESS_STATE_FILE",
  "AWARENESS_AUDIT_FILE",
  "AWARENESS_POLL_AUDIT_FILE",
  "AI_PROVIDER",
  "AI_MODE",
  "AI_STATE_FILE",
  "AI_BUDGET_STATE_FILE",
  "NVIDIA_BASE_URL",
  "NVIDIA_API_KEY",
  "NVIDIA_MODEL_SUMMARY",
  "NVIDIA_MODEL_REASONING",
  "LLAMACPP_BASE_URL",
  "LLAMACPP_API_KEY",
  "LLAMACPP_MODEL_SUMMARY",
  "LLAMACPP_MODEL_REASONING",
  "LLAMACPP_ALLOW_PRIVATE_HTTP",
  "MARKET_PROVIDER",
  "MARKET_PROVIDER_FALLBACK",
  "MARKET_TWELVE_API_KEY",
  "MARKET_TWELVE_BASE_URL",
  "MARKET_YAHOO_BASE_URL",
  "MARKET_HISTORY_DIR",
  "MARKET_SNAPSHOT_FILE",
  "MARKET_CREDIT_STATE_FILE",
  "PROVIDER_QUOTA_STATE_FILE",
  "RESEARCH_NEWS_ARCHIVE_FILE",
  "RESEARCH_ALERT_STATE_FILE",
  "RESEARCH_LEDGER_FILE",
  "RESEARCH_SOURCES_FILE",
  "RESEARCH_SEC_USER_AGENT",
  "RESEARCH_SIGNAL_POLICY_FILE",
  "MCP_OPERATOR_CREDENTIALS_FILE",
  "STORAGE_DB_PATH",
  "OGID_SIGNAL_HISTORY_FILE",
  "OGID_BUILD_COMMIT",
  "OGID_BUILD_TIME"
]);


const applicationKey=/^(STORAGE_|NEWS_|NEWSAPI_|GNEWS_|MEDIA_|MEDIASTACK_|GDELT_|MARKET_|TWELVE_|TWELVEDATA_|YOUTUBE_|WATCHLIST_|REFRESH_|MANUAL_|WS_|IMPACT_|ADMIN_|AI_|NVIDIA_|LLAMACPP_|AWARENESS_|RESEARCH_|MCP_OPERATOR_|ALLOW_)/;
export function unsupportedDeploymentVariables(env) {
  return Object.keys(env).filter(key=>(applicationKey.test(key) || key === "DISABLE_BACKGROUND_REFRESH") && !DEPLOYMENT_ENV_KEYS.includes(key));
}
export function validateDeploymentEnvironment(env) {
  const invalid=key=>{throw Object.assign(new Error(`Invalid deployment setting: ${key}`),{code:"CONFIG_INVALID_DEPLOYMENT"});};
  for(const [key,values] of Object.entries({
    AI_PROVIDER:["none","nvidia","llamacpp"],AI_MODE:["off","shadow","visible"],AWARENESS_MODE:["off","shadow","visible"],
    MARKET_PROVIDER:["twelve","yahoo"],MARKET_PROVIDER_FALLBACK:["twelve","yahoo"],LOG_LEVEL:["error","warn","info","debug"]
  }))if(env[key]?.trim() && !values.includes(env[key].trim().toLowerCase()))invalid(key);
  if(env.PORT?.trim() && (!/^\d+$/.test(env.PORT.trim()) || Number(env.PORT)>65535))invalid("PORT");
  for(const key of ["ALLOW_LOCAL_ADMIN","ALLOW_LAN_ADMIN","LLAMACPP_ALLOW_PRIVATE_HTTP"])
    if(env[key]?.trim() && !["1","0","true","false","yes","no","on","off"].includes(env[key].trim().toLowerCase()))invalid(key);
  if(env.NEWS_PROVIDERS?.trim() && env.NEWS_PROVIDERS.split(",").some(value=>!["newsapi","gnews","mediastack","gdelt","rss"].includes(value.trim().toLowerCase())))invalid("NEWS_PROVIDERS");
}
