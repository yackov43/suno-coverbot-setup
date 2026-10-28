import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPublicTrust} from './public-keys.mjs';
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function componentSourceIdentity(component,trust){
  const hash=createHash('sha256');
  const folders=component==='android'?['android-connector/app/src','android-connector/gradle']:component==='setup'?['scripts/setup-tool','scripts/setup-pilot','src/update-control']:['extension'];
  for(const folder of folders)for(const rel of readdirSync(path.join(root,folder),{recursive:true}).sort()){
    const file=path.join(root,folder,rel);if(!statSync(file).isFile()||/\.pem$|auto-allow-bin|auto-allow\.exe|\.keystore$/.test(rel))continue;
    const bytes=readFileSync(file);hash.update(folder+'/'+rel.replaceAll('\\','/')+'\0'+bytes.length+'\0');hash.update(bytes);
  }
  if(component==='android')hash.update(readFileSync(path.join(root,'android-connector/app/build.gradle.kts')));
  const build_sha=hash.digest('hex');return {build_sha,content_hash:createHash('sha256').update(build_sha+JSON.stringify(trust)).digest('hex')};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(componentSourceIdentity(process.argv[2]||'android',buildPublicTrust()),null,2));
