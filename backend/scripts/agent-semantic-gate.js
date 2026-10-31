import {readFileSync} from 'node:fs';
import {semanticGate} from '../services/agent/semanticGate.js';
const [reviewFile]=process.argv.slice(2);
if(!reviewFile)throw Error('Uso: node scripts/agent-semantic-gate.js reviews.json');
const cases=JSON.parse(readFileSync(new URL('../evaluations/agent-semantic-cases.json',import.meta.url))).cases;
const report=semanticGate(cases,JSON.parse(readFileSync(reviewFile)).reviews||[]);
process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.passed?0:1;
