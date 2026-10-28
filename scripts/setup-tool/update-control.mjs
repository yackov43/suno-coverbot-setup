import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { canonical, verifyEnvelope } from '../../src/update-control/domain.js';
import { agentStatus, registerLaunchAgent } from './launchagent.mjs';
import { currentSid, taskNameFor, describeTask, registerUpdater, launcherScript } from '../setup-pilot/scheduler.mjs';
import { execFileSync } from 'node:child_process';

export const RELEASE_PUBLIC_KEY = typeof __SCB_RELEASE_PUBLIC_KEY__ === 'string' ? __SCB_RELEASE_PUBLIC_KEY__ : (process.env.SCB_RELEASE_PUBLIC_KEY || '');
export const ACTION_PUBLIC_KEY = typeof __SCB_ACTION_PUBLIC_KEY__ === 'string' ? __SCB_ACTION_PUBLIC_KEY__ : (process.env.SCB_ACTION_PUBLIC_KEY || '');
const atomic=(file,value)=>{const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(tmp,file);};

/** MEASURED: .NET's GetFullPath in the helper expands 8.3 segments of the part that exists (MEDIA-~1 -> media-print) and
 *  path.resolve does not, so the two derived different locks for one folder. Expand the same way; '~'-free paths are untouched. */
function canonicalFolder(directory){
  let full=path.resolve(directory);
  if(process.platform==='win32'&&full.includes('~')){
    let prefix=full;const rest=[];
    while(!existsSync(prefix)){const parent=path.dirname(prefix);if(parent===prefix)break;rest.unshift(path.basename(prefix));prefix=parent;}
    try{full=path.join(realpathSync.native(prefix),...rest);}catch{/* keep the lexical form */}
  }
  return full.toLowerCase();
}
const lockDigest=directory=>createHash('sha256').update(canonicalFolder(directory)).digest('hex');
/** One name per extension folder; public/helper-update.ps1 derives the same name (GetFullPath + TrimEnd('\') + ToLowerInvariant). */
export const componentLockName=directory=>'SunoCoverBot-updater-'+lockDigest(directory).slice(0,32);
/**
 * Kernel-owned lock, released even on process crash. No PID-based stale-lock stealing.
 * Windows: a named pipe. MEASURED 2026-10-28: the former loopback port 48000-57999 overlaps the dynamic range (399 of those
 * ports were in use on a development PC; our own CDP bridge holds 47832) and a real E2E run hit a false UPDATER_BUSY - a skipped
 * update nobody sees. A pipe name cannot collide with unrelated sockets; Node and Windows PowerShell 5.1 deny each other on it,
 * and a killed holder frees it at once (measured both ways). macOS has no PowerShell helper: a loopback port below its dynamic
 * range (49152-65535).
 */
export async function acquireComponentLock(directory,{platform=process.platform}={}) {
  if(!path.isAbsolute(directory))throw Error('invalid_directory');
  const server=net.createServer(socket=>socket.destroy());
  const address=platform==='win32'?{path:'\\\\.\\pipe\\'+componentLockName(directory)}:{port:40000+(parseInt(lockDigest(directory).slice(0,6),16)%9000),host:'127.0.0.1',exclusive:true};
  await new Promise((resolve,reject)=>{server.once('error',()=>reject(Error('UPDATER_BUSY')));server.listen(address,resolve);});
  let legacyHandle=null;
  if(platform==='win32'){
    try{legacyHandle=openSync(path.join(os.tmpdir(),'scb-updater.lock'),'a+');}
    catch{await new Promise(resolve=>server.close(resolve));throw Error('UPDATER_BUSY');}
  }
  return ()=>{if(legacyHandle!==null)closeSync(legacyHandle);return new Promise(resolve=>server.close(resolve));};
}
export function nativeIdentity(home) {
  mkdirSync(home,{recursive:true});const file=path.join(home,'monitor-identity.json');
  if(existsSync(file))return JSON.parse(readFileSync(file,'utf8'));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const value={installation_id:randomUUID(),sequence:0,private_key:privateKey.export({type:'pkcs8',format:'pem'}),public_key:publicKey.export({type:'spki',format:'pem'}),architecture:process.arch==='arm64'?'arm64':process.arch==='x64'?'x64':'x86'};
  // Exclusive creation prevents competing first launches from minting different identities.
  try{writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;return JSON.parse(readFileSync(file,'utf8'));}
  return value;
}
export function bindNativeMarker(home,directory) {
  const id=nativeIdentity(home),file=path.join(directory,'scb-native-updater.json');
  let marker={};try{marker=JSON.parse(readFileSync(file,'utf8'));}catch{}
  atomic(file,{...marker,installation_id:id.installation_id,public_key:id.public_key,architecture:id.architecture,authority:'setup-tool'});
}
export async function nativeHeartbeat({home,base,report,fetchImpl=fetch}) {
  const origin=new URL(base);
  if(origin.protocol!=='https:'&&!(process.env.SCB_UPDATER_TEST==='1'&&origin.protocol==='http:'&&origin.hostname==='127.0.0.1'))throw Error('requires_https');
  const id=nativeIdentity(home);id.sequence++;atomic(path.join(home,'monitor-identity.json'),id);
  const body={source:'updater',sequence:id.sequence,...report},timestamp=Date.now();
  const signature=sign(null,Buffer.from(id.installation_id+'\n'+timestamp+'\n'+canonical(body)),id.private_key).toString('base64');
  const r=await fetchImpl(base+'/api/update-control/heartbeat',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json','x-scb-installation':id.installation_id,'x-scb-timestamp':String(timestamp),'x-scb-signature':signature},body:JSON.stringify(body)});
  if(!r.ok)throw Error(r.status===401?'NOT_ENROLLED':'CONTROL_HTTP_'+r.status);
  return r.json();
}
export function approvedComponent(envelope,{component='extension',platform='chrome',architecture='universal',key=RELEASE_PUBLIC_KEY}={}) {
  if(!key)throw Error('release_trust_not_configured');
  const r=verifyEnvelope(envelope,key,'release');
  const c=r.components?.find(c=>c.component_type===component&&[platform,'chrome'].includes(c.platform)&&[architecture,'universal'].includes(c.architecture));
  if(!c)throw Error('unsupported_release_component');
  return {...c,release_id:r.release_id,envelope,sha256:c.artifact_hash,url:c.artifact_path};
}
export function allowedAction(envelope,id,releaseId,key=ACTION_PUBLIC_KEY) {
  const a=verifyEnvelope(envelope,key,'action');
  if(a.installation_id!==id||!Number.isFinite(Date.parse(a.expires_at))||Date.parse(a.expires_at)<=Date.now()||Date.parse(a.expires_at)>Date.now()+32*60000||a.release_id&&a.release_id!==releaseId)throw Error('action_expired_or_denied');
  if(!['CHECK_STATUS','REPAIR_SCHEDULER','RETRY_UPDATE'].includes(a.action))throw Error('UNSUPPORTED_ACTION');
  return a;
}
export function schedulerHealth(home,{platform=process.platform,run=execFileSync}={}) {
  const exe=path.join(home,platform==='darwin'?'SunoCoverBotSetup-core':'SunoCoverBotSetup.exe');
  if(!existsSync(exe))return 'MISSING';
  if(platform==='darwin'){
    const s=agentStatus({run,corePath:exe});return s.loaded&&s.runsUpdate&&s.interval?'HEALTHY':'MISSING';
  }
  if(platform!=='win32')return 'UNKNOWN';
  try{const sid=currentSid(),launcher=path.join(home,'update-launch.vbs');
    const text=run(path.join(process.env.SystemRoot||'C:/Windows','System32','schtasks.exe'),['/Query','/TN',taskNameFor(sid),'/XML'],{encoding:'utf8',windowsHide:true});
    return Object.values(describeTask(text,sid,launcher)).every(Boolean)?'HEALTHY':'FAILED';
  }catch{return 'MISSING';}
}
export function repairScheduler(home) {
  const exe=path.join(home,process.platform==='darwin'?'SunoCoverBotSetup-core':'SunoCoverBotSetup.exe');
  if(!existsSync(exe))throw Error('UPDATER_NOT_REGISTERED');
  if(process.platform==='darwin')registerLaunchAgent({corePath:exe,home});
  else if(process.platform==='win32'){
    const launcher=path.join(home,'update-launch.vbs');writeFileSync(launcher,launcherScript(exe,'--update'));
    registerUpdater({directory:home,launcherPath:launcher});
  }else throw Error('UNSUPPORTED_ACTION');
  if(schedulerHealth(home)!=='HEALTHY')throw Error('UPDATER_NOT_REGISTERED');
}
/** Retire only this user's known historical task, after native registration has been verified. */
export function retireLegacyScheduler({sid=null,run=execFileSync}={}) {
  if(process.platform!=='win32')return;
  sid ||= currentSid();
  try{run(path.join(process.env.SystemRoot||'C:/Windows','System32','schtasks.exe'),['/Delete','/TN','SunoCoverBot-Extension-Update-'+sid,'/F'],{encoding:'utf8',windowsHide:true,stdio:'ignore'});}catch{/* task absent; marker also makes new legacy scripts passive */}
}
