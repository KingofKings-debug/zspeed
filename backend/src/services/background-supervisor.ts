import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishFleetEventSocket } from './fleet-event.service.js';

let child:ChildProcess|null=null;
let timer:ReturnType<typeof setInterval>|null=null;
let stopped=false, requests=0;
export function recordReadLoad() { requests++; }
export function startBackgroundWorker():void {
  if(timer) return;
  const db=path.resolve(process.env.DB_PATH || 'data/zspeed.db');
  const lock=`${db}.worker-lock`;
  const lockState=()=>JSON.stringify({parent:process.pid,worker:child?.pid || null});
  try { fs.writeFileSync(lock,lockState(),{flag:'wx'}); }
  catch {
    const state=JSON.parse(fs.readFileSync(lock,'utf8'));
    const owner=Number(typeof state==='number'?state:state.parent);
    let alive=false;
    if(owner>0) { try { process.kill(owner,0); alive=true; } catch(error:any) { if(error.code!=='ESRCH') throw error; } }
    if(alive) throw new Error('Another backend owns the background worker for this database. Stop it before starting another backend.');
    if(state.worker>0) { try { process.kill(state.worker,'SIGTERM'); } catch(error:any) { if(error.code!=='ESRCH') throw error; } }
    fs.unlinkSync(lock); fs.writeFileSync(lock,lockState(),{flag:'wx'});
  }
  stopped=false;
  const directory=path.dirname(fileURLToPath(import.meta.url));
  const compiled=fs.existsSync(path.join(directory,'background-runtime.js'));
  const launch=()=>{
    if(stopped) return;
    child=fork(path.join(directory,`background-runtime.${compiled?'js':'ts'}`),[],{env:{...process.env,ZSPEED_BACKGROUND_WORKER:'true'},execArgv:compiled?[]:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc']});
    fs.writeFileSync(lock,lockState());
    child.on('message',(message:any)=>{if(message?.type==='fleet-event') publishFleetEventSocket(message.event);});
    child.on('error',error=>console.error('[background supervisor]',error.message));
    child.on('exit',(code)=>{ child=null; if(!stopped) { console.error(`[background supervisor] Worker exited (${code}); restarting in 5 seconds`); setTimeout(launch,5000).unref(); } });
  };
  launch();
  timer=setInterval(()=>{ if(child?.connected) child.send({type:'load',requests}); requests=0; },1000);
  const cleanup=()=>{
    stopped=true; if(timer) clearInterval(timer); timer=null; child?.kill(); child=null;
    try { const state=JSON.parse(fs.readFileSync(lock,'utf8'));if(state.parent===process.pid) fs.unlinkSync(lock); } catch {}
  };
  process.once('exit',cleanup);
  for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{cleanup();process.exit(0);});
}
