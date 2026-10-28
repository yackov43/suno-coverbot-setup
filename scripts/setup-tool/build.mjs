// Builds public/SunoCoverBotSetup.exe: the standalone setup tool (Node SEA, GUI subsystem: designed window, no terminal; logo icon; real version metadata).
//   node scripts/setup-tool/build.mjs
// Steps: esbuild bundle (CJS, trusted key baked in) -> SEA blob -> copy node.exe -> strip Node's signature -> icon + version
// info (rcedit) -> inject blob (postject) -> OPTIONAL Authenticode signing -> SHA-256 file.
// Signing is a real certificate or nothing. It runs only when one is provided; a self-signed certificate would be untrusted on
// every other PC and is deliberately not offered:
//   SCB_SIGN_PFX=<path to .pfx>  SCB_SIGN_PFX_PASSWORD=<password>            (OV/EV certificate file)
//   SCB_SIGN_AZURE_DLIB=<Azure.CodeSigning.Dlib.dll> SCB_SIGN_AZURE_METADATA=<metadata.json>   (Azure Trusted Signing)
// signtool.exe (Windows SDK) must be on PATH. The timestamp keeps the signature valid after the certificate expires.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAssets } from './assets.mjs';
import { buildPublicTrust } from '../update-control/public-keys.mjs';
import {componentSourceIdentity} from '../update-control/source-identity.mjs';
const publicTrust=buildPublicTrust();

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const OUT = path.join(ROOT, 'scratch', 'setup-tool-build');
const TOOLS = path.join(ROOT, 'scratch', 'build-tools');
const EXE = path.join(OUT, 'SunoCoverBotSetup.exe');
const PUBLIC_EXE = EXE; // candidate remains isolated until the approved publication gate
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', cwd: ROOT, ...options });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

mkdirSync(OUT, { recursive: true }); mkdirSync(TOOLS, { recursive: true });
if (!existsSync(path.join(TOOLS, 'node_modules', 'esbuild'))) run(npm, ['install', '--prefix', TOOLS, '--no-audit', '--no-fund', '--loglevel=error', 'esbuild@0.28.2', 'postject@1.0.0-alpha.6', 'rcedit@4.0.1'], { shell: true });
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const toolVersion = /TOOL_VERSION = '([\d.]+)'/.exec(readFileSync(path.join(ROOT, 'scripts', 'setup-tool', 'main.mjs'), 'utf8'))[1];

// 1. Bundle. The trusted extension key is baked in; nothing is read from the repo at run time.
const esbuild = await import(pathToFileURL(path.join(TOOLS, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
await esbuild.build({ entryPoints: [path.join(ROOT, 'scripts', 'setup-tool', 'main.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  absWorkingDir:ROOT,tsconfigRaw:{},plugins:[{name:'workspace-source',setup(build){
    // Resolve only task-owned source through Node. Do not walk or enumerate protected parent directories.
    build.onResolve({filter:/.*/},args=>{
      if(args.path.startsWith('node:'))return {path:args.path,external:true};
      if(!path.isAbsolute(args.path)&&!args.path.startsWith('.'))throw Error('unexpected_setup_dependency');
      const file=path.resolve(args.importer?path.dirname(args.importer):ROOT,args.path);
      if(!file.startsWith(ROOT+path.sep))throw Error('setup_source_outside_workspace');
      return {path:file,namespace:'scb-source'};
    });
    build.onLoad({filter:/.*/,namespace:'scb-source'},args=>({contents:readFileSync(args.path,'utf8'),loader:args.path.endsWith('.json')?'json':'js'}));
  }}],
  outfile: path.join(OUT, 'setup-tool.cjs'), define: { __SCB_KEY__: JSON.stringify(manifest.key), __SCB_BASE__: JSON.stringify('https://46-225-2-111.sslip.io'),
    __SCB_RELEASE_PUBLIC_KEY__: JSON.stringify(publicTrust.release_public_key), __SCB_ACTION_PUBLIC_KEY__: JSON.stringify(publicTrust.action_public_key),
    __SCB_ASSETS__: JSON.stringify(JSON.stringify(loadAssets(null))), 'import.meta.url': '"file:///setup-tool/"' }, legalComments: 'none', logLevel: 'warning' });

// 2. SEA blob + a private copy of node.exe.
writeFileSync(path.join(OUT, 'sea-config.json'), JSON.stringify({ main: 'setup-tool.cjs', output: 'setup-tool.blob', disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: OUT });
copyFileSync(process.execPath, EXE);

// 3. Node's own signature is invalid once the binary is modified; strip it first so the result is cleanly unsigned.
run(process.execPath, [path.join(ROOT, 'connector', 'strip-signature.cjs'), EXE]);
await new Promise(r => setTimeout(r, 600));

// 4. Icon (the square logo icon already used by the site card) + honest version metadata.
const rcedit = (await import(pathToFileURL(path.join(TOOLS, 'node_modules', 'rcedit', 'lib', 'rcedit.js')).href)).default;
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await rcedit(EXE, {
      icon: path.join(ROOT, 'connector', 'icon', 'app.ico'),
      'version-string': { ProductName: 'Suno CoverBot Setup', FileDescription: 'Suno CoverBot Setup - installs the Suno CoverBot browser extension and its automatic updates',
        CompanyName: 'Suno CoverBot', LegalCopyright: 'Suno CoverBot', OriginalFilename: 'SunoCoverBotSetup.exe', InternalName: 'SunoCoverBotSetup' },
      'file-version': toolVersion, 'product-version': toolVersion,
    });
    break;
  } catch (err) {
    if (attempt === 4) throw err;
    await new Promise(r => setTimeout(r, 800));
  }
}

// 5. Inject the SEA payload.
run(process.execPath, [path.join(TOOLS, 'node_modules', 'postject', 'dist', 'cli.js'), EXE, 'NODE_SEA_BLOB', path.join(OUT, 'setup-tool.blob'), '--sentinel-fuse', FUSE]);

// 5b. GUI subsystem: double-click shows the designed window and NO black terminal. (Node behaves the same either way.)
run(process.execPath, [path.join(ROOT, 'connector', 'hide-console.cjs'), EXE]);

// 6. Optional Authenticode signature (real certificate only).
let signed = false;
if (process.env.SCB_SIGN_PFX && existsSync(process.env.SCB_SIGN_PFX)) {
  run('signtool', ['sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', '/f', process.env.SCB_SIGN_PFX, '/p', process.env.SCB_SIGN_PFX_PASSWORD || '', EXE]);
  signed = true;
} else if (process.env.SCB_SIGN_AZURE_DLIB && process.env.SCB_SIGN_AZURE_METADATA) {
  run('signtool', ['sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', process.env.SCB_SIGN_AZURE_DLIB, '/dmdf', process.env.SCB_SIGN_AZURE_METADATA, EXE]);
  signed = true;
}
if (signed) run('signtool', ['verify', '/pa', '/v', EXE]);

// Distribution is performed only by the approved release publisher.
const sha256 = createHash('sha256').update(readFileSync(PUBLIC_EXE)).digest('hex');
writeFileSync(path.join(OUT, 'SunoCoverBotSetup.exe.sha256'), `${sha256}  SunoCoverBotSetup.exe\n`);
const immutable='SunoCoverBotSetup-'+sha256.slice(0,16)+'.exe';copyFileSync(EXE,path.join(OUT,immutable));
writeFileSync(path.join(OUT,'component.json'),JSON.stringify({component_type:'windows-setup',platform:'windows',architecture:process.arch==='arm64'?'arm64':'x64',version:toolVersion,
  artifact_path:'/'+immutable,artifact_hash:sha256,...componentSourceIdentity('setup',publicTrust),api_contract:1,schema_min:1,schema_max:1},null,2)+'\n');
console.log(JSON.stringify({ file: path.relative(ROOT, PUBLIC_EXE), bytes: readFileSync(PUBLIC_EXE).length, sha256, toolVersion, signed }));
