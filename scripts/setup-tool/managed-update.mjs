import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import {ERRORS} from '../../src/update-control/domain.js';
import { installedVersion, installPackage } from '../setup-pilot/install-package.mjs';
import { fetchReleaseMeta, fetchPublicRelease, isNewerVersion, developerModeOffProfiles } from './lib.mjs';
import { acquireComponentLock, bindNativeMarker, nativeHeartbeat, nativeIdentity, schedulerHealth, repairScheduler, allowedAction, approvedComponent } from './update-control.mjs';

/** The setup tool updates itself from the same signed release as the extension: download, check the signed hash,
 * then swap the file the scheduler and the protocol handler start. The running copy finishes this run; the next run
 * is the new version. Windows renames a running executable, it only refuses to overwrite it. */
export async function updateSetupTool({home,envelope,toolVersion,base,log=()=>{},deps={}}) {
  const d={approvedComponent,fetchImpl:fetch,platform:process.platform,arch:process.arch,...deps};
  if(d.platform!=='win32'||!envelope)return null;
  let c;try{c=d.approvedComponent(envelope,{component:'windows-setup',platform:'windows',architecture:d.arch==='arm64'?'arm64':'x64'});}catch{return null;}
  if(!isNewerVersion(c.version,toolVersion))return null;
  const url=new URL(c.url,base);if(url.origin!==new URL(base).origin)throw Error('setup_origin_denied');
  const response=await d.fetchImpl(url,{redirect:'error'});if(!response.ok)throw Error('setup_download_failed');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==c.sha256)throw Error('setup_hash_mismatch');
  const exe=path.join(home,'SunoCoverBotSetup.exe'),next=exe+'.next',old=exe+'.old';
  writeFileSync(next,bytes);rmSync(old,{force:true});
  if(existsSync(exe))renameSync(exe,old);
  try{renameSync(next,exe);}catch(error){if(existsSync(old)&&!existsSync(exe))renameSync(old,exe);throw error;}
  log('update.log','setup tool '+toolVersion+' -> '+c.version+' installed; the next scheduled run starts it');
  return {from:toolVersion,to:c.version};
}

/** Quiet update shared by Task Scheduler, LaunchAgent and the protocol handler. No onboarding/window code here. */
export async function managedUpdate({home,config,toolVersion,reloadChrome=true,log=()=>{},deps={}}) {
  const d={installedVersion,installPackage,fetchReleaseMeta,fetchPublicRelease,developerModeOffProfiles,acquireComponentLock,bindNativeMarker,nativeHeartbeat,nativeIdentity,schedulerHealth,repairScheduler,allowedAction,approvedComponent,
    loadIntoChrome:async(directory,options)=>(await import('./chrome.mjs')).loadIntoChrome(directory,options),...deps};
  const releaseLock=await d.acquireComponentLock(config.directory);
  const stateFile=path.join(home,'update-operation.json');let state={};
  const save=()=>{const tmp=stateFile+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(state),{mode:0o600});renameSync(tmp,stateFile);};
  let action=null;
  const report=async(extra={})=>d.nativeHeartbeat({home,base:config.base,report:{updater_version:toolVersion,installed_version:d.installedVersion(config.directory)||'',updater_health:d.schedulerHealth(home),...extra}});
  try{
    try{state=JSON.parse(readFileSync(stateFile,'utf8'));}catch{}
    d.bindNativeMarker(home,config.directory);
    const identity=d.nativeIdentity(home);
    // Control plane unreachable, rate-limited or not yet enrolled: nothing was attempted. Without this the catch below
    // matched "CONTROL_HTTP_429" against /HTTP/, recorded DOWNLOAD_FAILED and pushed the local retry schedule out.
    let status;try{status=await report();}catch(error){log('update.log','control plane unavailable: '+String(error?.message||error));return {pending:true,state:'OFFLINE',reason:String(error?.message||'CONTROL_UNAVAILABLE')};}
    let meta=status?.target?d.approvedComponent(status.target.envelope):null;
    // The previous copy of the tool, kept until a new one has run once; then the tool keeps itself current.
    try{rmSync(path.join(home,'SunoCoverBotSetup.exe.old'),{force:true});}catch{}
    await updateSetupTool({home,envelope:status?.target?.envelope,toolVersion,base:config.base,log,deps:d.setupTool}).catch(error=>log('update.log','setup tool update deferred: '+String(error?.message||error)));
    // A release signature is checked locally even if the server is authenticated.
    if(meta&&!meta.release_id)throw Error('release_not_approved');
    if(meta&&state.release_id!==meta.release_id)state={release_id:meta.release_id,attempts:0};
    for(const envelope of status?.actions||[]){
      const candidate=d.allowedAction(envelope,identity.installation_id,meta?.release_id||null);
      if(state.finished_operations?.[candidate.operation_id])continue;
      if(candidate.action==='RETRY_UPDATE'&&candidate.automatic!==false&&(state.attempts>=5||state.next_retry_at>Date.now()))return {pending:true,state:state.attempts>=5?'USER_ACTION_REQUIRED':'RETRY_SCHEDULED'};
      if(candidate.automatic===false&&state.last_manual_operation!==candidate.operation_id){state.attempts=0;state.next_retry_at=null;state.last_manual_operation=candidate.operation_id;save();}
      action=candidate;
      await report({operation_id:action.operation_id,action_result:'RECEIVED'});
      await report({operation_id:action.operation_id,action_result:'STARTED'});
      if(action.action==='REPAIR_SCHEDULER')d.repairScheduler(home);
      if(['CHECK_STATUS','REPAIR_SCHEDULER'].includes(action.action)){
        await report({operation_id:action.operation_id,action_result:'COMPLETED'});
        state.finished_operations={...(state.finished_operations||{}),[action.operation_id]:action.expires_at};save();action=null;
      }
      break;
    }
    if(!meta)return {pending:true,state:'UNKNOWN',reason:'NO_ELIGIBLE_APPROVED_RELEASE'};
    if(!action)return {pending:true,state:'UPDATE_QUEUED'};
    const installed=d.installedVersion(config.directory);
    let diskBuild=null;try{diskBuild=JSON.parse(readFileSync(path.join(config.directory,'build-identity.json'),'utf8'));}catch{}
    if(installed===meta.version&&diskBuild?.build_sha===meta.build_sha&&diskBuild?.content_hash===meta.content_hash){
      // Files are current. Independent runtime heartbeat decides whether Chrome is current.
      await report({update_state:'AWAITING_RUNTIME_RELOAD',...(action?{operation_id:action.operation_id,action_result:'COMPLETED'}:{})}).catch(()=>{});
      return {version:installed,changed:false,pending:true};
    }
    if(installed&&installed!==meta.version&&!isNewerVersion(meta.version,installed))throw Error('UNSUPPORTED_ACTION');
    // Chrome disables an unpacked extension that reloads with developer mode off, and a disabled extension never reports
    // again. Keep the working version running and say why, rather than install into a silent failure.
    const developerModeOff=d.developerModeOffProfiles(config.directory);
    if(developerModeOff.length){log('update.log','update held: Chrome developer mode is off in '+developerModeOff.join(', '));
      await report({update_state:'USER_ACTION_REQUIRED',last_error_code:'CHROME_PERMISSION_REQUIRED',...(action?{operation_id:action.operation_id,action_result:'FAILED'}:{})}).catch(()=>{});
      return {pending:true,state:'USER_ACTION_REQUIRED',reason:'CHROME_PERMISSION_REQUIRED',profiles:developerModeOff};}
    state.operation_id=action?.operation_id||state.operation_id||randomUUID();state.attempts=(state.attempts||0)+1;state.state='DOWNLOADING';state.next_retry_at=Date.now()+60000*2**Math.min(state.attempts,6);save();
    await report({operation_id:state.operation_id,update_state:'DOWNLOADING'}).catch(()=>{});
    const {release,bytes}=await d.fetchPublicRelease({base:config.base,key:config.key,meta});
    state.state='VERIFYING_PACKAGE';state.downloaded_version=release.version;save();
    await report({operation_id:state.operation_id,update_state:state.state,downloaded_version:release.version});
    state.state='INSTALLING';save();
    // Revalidate authorization after download, before writing files. A pause/revocation/changed release denies this phase.
    await report({operation_id:state.operation_id,update_state:state.state,downloaded_version:release.version});
    const result=d.installPackage(bytes,release,{key:config.key,directory:config.directory,previousVersion:installed,registered:d.schedulerHealth(home)==='HEALTHY'});
    d.bindNativeMarker(home,config.directory);state.state='AWAITING_RUNTIME_RELOAD';save();
    await report({operation_id:state.operation_id,artifact_hash:meta.sha256,downloaded_version:release.version,update_state:state.state,...(action?{action_result:'COMPLETED'}:{})}).catch(()=>{});
    // The extension reads the signed target identity and reloads itself. A scheduled updater never restarts the user's browser.
    log('update.log','files installed; independent runtime heartbeat and bounded extension reload required');
    if(action)state.finished_operations={...(state.finished_operations||{}),[action.operation_id]:action.expires_at};
    for(const [id,expiry]of Object.entries(state.finished_operations||{}))if(Date.parse(expiry)<Date.now())delete state.finished_operations[id];
    state.error=null;state.next_retry_at=null;save();
    return {version:result.version,changed:true,pending:true,operation_id:state.operation_id};
  }catch(error){
    const text=String(error?.message||'');
    const code=ERRORS.has(text)?text:/sign|trust|approved/i.test(text)?'RELEASE_ARTIFACT_MISMATCH':/hash|sha256|checksum/i.test(text)?'HASH_MISMATCH':/download|fetch|HTTP/i.test(text)?'DOWNLOAD_FAILED':action?.action==='REPAIR_SCHEDULER'?(process.platform==='darwin'?'MAC_LAUNCHAGENT_FAILED':'UPDATER_NOT_REGISTERED'):'INSTALL_FAILED';
    state.error=code;state.state=['RELEASE_ARTIFACT_MISMATCH','UNSUPPORTED_ACTION'].includes(code)?'USER_ACTION_REQUIRED':state.attempts>=5?'FAILED':'RETRY_SCHEDULED';
    state.next_retry_at=Date.now()+Math.min(3600000,60000*2**Math.min(state.attempts||1,6))*(1+Math.random()*.25);save();
    await report({last_error_code:code,update_state:state.state,...(action?{operation_id:action.operation_id,action_result:'FAILED'}:{})}).catch(()=>{});
    log('update.log',code);throw error;
  }finally{await releaseLock();}
}
