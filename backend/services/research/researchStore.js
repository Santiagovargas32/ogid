import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../../utils/error.js";
const empty = () => ({ schemaVersion:"research-ledger-v1", revision:0, events:{}, jobs:{}, holdings:{}, companyFacts:{}, sourceStates:{}, forecasts:{} });
// Un escritor por proceso. Publicar varios workers requiere base transaccional compartida.
export class ResearchStore {
  constructor({ persistencePath = null, maxEntries = 20000 } = {}) {
    this.path=persistencePath;this.maxEntries=maxEntries;this.state=empty();
    if(this.path) try { const value=JSON.parse(readFileSync(this.path,"utf8")); if(value.schemaVersion!==this.state.schemaVersion || !Number.isInteger(value.revision)) throw new Error();
      for(const key of ["events","jobs","holdings","companyFacts","sourceStates","forecasts"]) if(!value[key] || Array.isArray(value[key]) || typeof value[key]!=="object") throw new Error();this.state=value;
    } catch(error) { if(error.code!=="ENOENT") throw new AppError("No se puede recuperar research ledger; conservar el archivo.",503,"RESEARCH_RECOVERY_FAILED"); }
  }
  transact(fn) {
    const next=structuredClone(this.state);const result=fn(next);
    for(const key of ["events","jobs","holdings","companyFacts","sourceStates","forecasts"]) if(Object.keys(next[key]).length>this.maxEntries) throw new AppError("Ledger lleno; archivar explícitamente antes de continuar.",507,"RESEARCH_CAPACITY");
    if(Buffer.byteLength(JSON.stringify(next))>67108864)throw new AppError("Ledger excede 64 MiB.",507,"RESEARCH_CAPACITY");
    next.revision++;
    if(this.path) { mkdirSync(dirname(this.path),{recursive:true,mode:0o700});const temp=`${this.path}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(next),{mode:0o600});renameSync(temp,this.path); }
    this.state=next;return structuredClone(result ?? null);
  }
  view(table) { return structuredClone(this.state[table]); }
}
