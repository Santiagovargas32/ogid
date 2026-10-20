// Node IPC closes even if npm/backend is killed unexpectedly. OpenCode and its
// MCP children stay in this owned group, never in the personal OpenCode group.
import { spawn } from "node:child_process";
const [binary,...args]=process.argv.slice(2);
// The parent runtime drains these pipes into bounded, redacted diagnostics.
const child=spawn(binary,args,{env:process.env,stdio:["ignore","inherit","inherit"]});
let stopping=false;
function stop(){
  if(stopping)return;stopping=true;
  try{process.kill(-process.pid,"SIGTERM");}catch{}
  const timeout=setTimeout(()=>{try{process.kill(-process.pid,"SIGKILL");}catch{}},10000);timeout.unref();
}
process.on("SIGTERM",stop);process.on("SIGINT",stop);process.on("disconnect",stop);
child.once("error",()=>process.exit(1));
child.once("exit",(code)=>{if(stopping){try{process.kill(-process.pid,"SIGTERM");}catch{}}process.exit(code || 0);});
