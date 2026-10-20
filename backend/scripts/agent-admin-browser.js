// Browser regression against an already running local backend. GET only.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const [base='http://127.0.0.1:3000',directory]=process.argv.slice(2);
const url=new URL(base);
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!directory)throw Error('Usage: agent-admin-browser http://127.0.0.1:PORT NEW-output-directory');
const output=resolve(directory);mkdirSync(output,{mode:0o700});
const {chromium}=await import(process.env.OGID_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});
const report={startedAt:new Date().toISOString(),base,checks:[],errors:[],legacyRequests:0};
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/ai-enrichments'))report.legacyRequests++;});
 await page.goto(new URL('/admin',base).href,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>document.getElementById('agent-activity-body')?.textContent.includes('Trabajos acumulados'),{timeout:30000});
 assert.equal(await page.locator('#agent-activity-body table').count(),1);
 await page.waitForFunction(()=>document.getElementById('agent-background-model')?.disabled===false,{timeout:30000});
 report.models=await page.locator('#agent-background-model').evaluate(select=>({total:select.options.length,enabled:[...select.options].filter(o=>!o.disabled).length,selected:select.value}));
 assert.equal(await page.locator('#ai-enrichments-body,#ai-diagnostics-body').count(),0);
 report.checks.push('Actual admin mounts jobs, processes and publications without legacy AI requests');
 const xss=await page.evaluate(async()=>{
  const {renderAgentOperations}=await import('/js/agentOperationsView.js');const target=document.createElement('div');document.body.append(target);
  const bad='<img src=x onerror="window.agentXss=true">javascript:alert(1)';
  renderAgentOperations({sampledAt:new Date().toISOString(),recentJobs:[{jobId:bad,task:bad,status:'failed',scope:bad,errorCode:bad}],recentPublications:[{mode:'shadow',model:bad,proposal:{summary:bad,evidenceIds:[bad]}}]},{activity:target,publications:target});
  const safe=!target.querySelector('img,script,a')&&!window.agentXss&&target.textContent.includes(bad);target.remove();return safe;
 });assert.equal(xss,true);report.checks.push('Model content is rendered as text, never HTML or executable links');
 await page.screenshot({path:resolve(output,'admin-desktop.png'),fullPage:true});
 await page.locator('#agent-activity-body').screenshot({path:resolve(output,'agent-activity.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(output,'admin-mobile.png'),fullPage:true});
 assert.equal(report.legacyRequests,0);assert.deepEqual(report.errors,[]);
 report.status='passed';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
finally{await browser.close();report.finishedAt=new Date().toISOString();writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));}
