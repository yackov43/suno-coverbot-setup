// macOS setup never quits/restarts the customer's browser or bypasses its permissions.
// A supported one-time manual/Store installation is followed by authenticated runtime read-back.
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BASE} from './lib.mjs';
import {nativeHeartbeat,approvedComponent,schedulerHealth} from './update-control.mjs';
import {installedVersion} from '../setup-pilot/install-package.mjs';
export const CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const dataVolumePath=p=>path.posix.join('/System/Volumes/Data',p);
/** Diagnostic inventory only. A PID never proves a loaded extension or authorizes a side effect. */
export function userChromePids(psOutput,{windowProfile=path.join(os.homedir(),'Library','Application Support','SunoCoverBot','setup','window-profile'),alias=dataVolumePath(path.join(os.homedir(),'Library','Application Support','Google','Chrome'))}={}){
  const result=[];
  for(const line of String(psOutput).split('\n')){
    const match=/^\s*(\d+)\s+(.*)$/.exec(line);if(!match)continue;
    const command=match[2];if(!command.startsWith(CHROME_BIN)||/\s--type=/.test(command)||command.includes(windowProfile))continue;
    result.push({pid:Number(match[1]),ours:command.includes(alias)});
  }
  return result;
}
const observations=new Map();
async function confirmRuntime(directory){
  const previous=observations.get(directory);if(previous&&Date.now()-previous.at<15000)return previous.value;
  const home=path.join(os.homedir(),'Library','Application Support','SunoCoverBot','setup');
  let value=null;
  if(existsSync(path.join(home,'monitor-identity.json')))try{
    const r=await nativeHeartbeat({home,base:BASE,report:{installed_version:installedVersion(directory)||'',updater_health:schedulerHealth(home)}});
    if(r.state==='CURRENT'&&r.target){const c=approvedComponent(r.target.envelope);value={verified:true,version:c.version};}
  }catch{/* not enrolled, unavailable or unverified stays a manual action */}
  observations.set(directory,{at:Date.now(),value});return value;
}
export async function loadIntoChromeMac(directory,{expectedVersion=null,deps={}}={}){
  const d={exists:existsSync,confirmRuntime,...deps};
  if(!d.exists(CHROME_BIN))return {ok:false,reason:'chrome_not_found'};
  const runtime=await d.confirmRuntime(directory);
  if(runtime?.verified&&runtime.version===expectedVersion)return {ok:true,version:runtime.version,reason:'runtime_verified'};
  return {ok:false,reason:'manual',userActionRequired:true};
}
