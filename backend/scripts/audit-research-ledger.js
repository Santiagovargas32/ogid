import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const file=path.resolve(process.argv[2] || new URL('../data/intel/research-ledger.json',import.meta.url).pathname);
const raw=readFileSync(file),data=JSON.parse(raw);const tables={};
for(const key of ['events','jobs','holdings','companyFacts','sourceStates','forecasts'])tables[key]={records:Object.keys(data[key] || {}).length,bytes:Buffer.byteLength(JSON.stringify(data[key] || {}))};
let started=performance.now();structuredClone(data);const cloneMs=performance.now()-started;
started=performance.now();const serialized=JSON.stringify(data);const stringifyMs=performance.now()-started;
console.log(JSON.stringify({schemaVersion:data.schemaVersion,revision:data.revision,ledgerBytes:raw.length,tables,cloneMs,stringifyMs,capacity:{entries:Object.entries(tables).filter(([,v])=>v.records>=20000).map(([table])=>table),bytes:Buffer.byteLength(serialized)>=67108864},readOnly:true},null,2));
