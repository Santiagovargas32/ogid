import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { unsupportedDeploymentVariables, validateDeploymentEnvironment } from "./deploymentEnv.js";

// Load before logger/build identity and other modules capture environment state.
// Test processes and workers receive their settings from their owner.
if(isMainThread && process.env.NODE_ENV !== "test") {
  dotenv.config({path:fileURLToPath(new URL("../.env",import.meta.url)),quiet:true});
  validateDeploymentEnvironment(process.env);
  const unsupported=unsupportedDeploymentVariables(process.env);
  if(unsupported.length)console.warn(JSON.stringify({timestamp:new Date().toISOString(),level:"warn",scope:"backend/config",message:"unsupported_environment_variables",variables:unsupported}));
}
