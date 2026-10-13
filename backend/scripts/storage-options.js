import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { storageConfig } from "../storage/config.js";

export function storageMaintenanceOptions(databasePath) {
  dotenv.config({path:fileURLToPath(new URL("../.env",import.meta.url))});
  const options=storageConfig({enabled:true,businessEnabled:false,isolateAnalysis:false,databasePath});
  if(!existsSync(options.databasePath))throw new Error("La base no existe; este comando no crea una base alternativa.");
  return options;
}
