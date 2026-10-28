#!/bin/bash
# Builds public/SunoCoverBotSetup-mac.tar.gz — the macOS twin of public/SunoCoverBotSetup.exe.
# A .tar.gz, not a .dmg (owner, 2026-10-26): the install is a curl one-liner, so the app only needs to be unpacked into
# ~/Applications. No disk image to mount, and curl never sets the quarantine flag that makes a browser-downloaded image
# look like malware. The old .dmg stays on the server so one-liners copied earlier keep working; nothing builds it any more.
# Same pipeline as the Windows SEA build (esbuild bundle → SEA blob → postject), packaged as a
# .app with CFBundleURLTypes for scbsetup:// and scbhelper:// so the connect page / extension can
# open the already-installed tool with ONE download control (OS auto-detected in api/connect.js).
#
# MUST run on a real Mac: Node SEA is not cross-compilable, and codesign is macOS-only.
# Usage (from repo root): bash scripts/setup-tool/build-mac.sh
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script must run on macOS (Node SEA is not cross-compilable)." >&2
  exit 1
fi
for tool in codesign iconutil osacompile plutil tar node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing '$tool'" >&2; exit 1; }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/scratch/setup-tool-mac-build"
TOOLS="$ROOT/scratch/build-tools"
APP_NAME="SunoCoverBotSetup"
BUNDLE="$OUT/$APP_NAME.app"
CORE_NAME="SunoCoverBotSetup-core"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
PUBLIC_PKG="$ROOT/scratch/release-candidates/SunoCoverBotSetup-mac.tar.gz"
mkdir -p "$ROOT/scratch/release-candidates"

echo "== 1/8: clean =="
rm -rf "$OUT" "$PUBLIC_PKG" "$PUBLIC_PKG.sha256"
mkdir -p "$OUT" "$TOOLS" "$ROOT/public"

echo "== 2/8: ensure build deps =="
if [[ ! -d "$TOOLS/node_modules/esbuild" ]]; then
  npm install --prefix "$TOOLS" --no-audit --no-fund --loglevel=error esbuild@0.28.2 postject@1.0.0-alpha.6
fi


# Windows-only payload is not needed or executed on Darwin.
export ROOT TOOLS OUT
ROOT="$ROOT" TOOLS="$TOOLS" OUT="$OUT" ROOT="$ROOT" TOOLS="$TOOLS" OUT="$OUT" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = process.env.ROOT;
const TOOLS = process.env.TOOLS;
const OUT = process.env.OUT;
const require = createRequire(path.join(TOOLS, 'package.json'));
const esbuild = await import(pathToFileURL(path.join(TOOLS, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
const { loadAssets } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'setup-tool', 'assets.mjs')).href);
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const {buildPublicTrust}=await import(pathToFileURL(path.join(ROOT,'scripts','update-control','public-keys.mjs')).href);
const publicTrust=buildPublicTrust();
await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'setup-tool', 'main.mjs')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  outfile: path.join(OUT, 'setup-tool.cjs'),
  define: {
    __SCB_KEY__: JSON.stringify(manifest.key),
    __SCB_AUTO_ALLOW_B64__: JSON.stringify(''),
    __SCB_AUTO_ALLOW_AVAILABLE__: 'false',
    __SCB_RELEASE_PUBLIC_KEY__: JSON.stringify(publicTrust.release_public_key),
    __SCB_ACTION_PUBLIC_KEY__: JSON.stringify(publicTrust.action_public_key),
    __SCB_BASE__: JSON.stringify('https://46-225-2-111.sslip.io'),
    __SCB_ASSETS__: JSON.stringify(JSON.stringify(loadAssets(null))),
    'import.meta.url': '"file:///setup-tool/"',
  },
  legalComments: 'none', logLevel: 'warning',
});
NODE

echo "== 4/8: SEA blob =="
printf '%s\n' '{"main":"setup-tool.cjs","output":"setup-tool.blob","disableExperimentalSEAWarning":true}' > "$OUT/sea-config.json"
(cd "$OUT" && node --experimental-sea-config sea-config.json)

echo "== 5/8: .app skeleton with URL schemes =="
# Minimal AppleScript applet that forwards sunoCoverBot URL opens to the SEA core as argv.
cat > "$OUT/launcher.applescript" <<'APPLESCRIPT'
on open location theURL
  set core to POSIX path of (path to resource "SunoCoverBotSetup-core")
  do shell script quoted form of core & " --launch " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location
on run
  set core to POSIX path of (path to resource "SunoCoverBotSetup-core")
  do shell script quoted form of core & " >/dev/null 2>&1 &"
end run
APPLESCRIPT
osacompile -o "$BUNDLE" "$OUT/launcher.applescript"
mkdir -p "$BUNDLE/Contents/Resources"

# Merge Info.plist: add scbsetup + scbhelper URL types
plutil -convert json -o "$OUT/osa-info.json" "$BUNDLE/Contents/Info.plist"
export ROOT TOOLS OUT
ROOT="$ROOT" TOOLS="$TOOLS" OUT="$OUT" OUT="$OUT" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const osa = JSON.parse(readFileSync(process.env.OUT + '/osa-info.json', 'utf8'));
const version=/TOOL_VERSION = '([\d.]+)'/.exec(readFileSync(process.env.ROOT+'/scripts/setup-tool/main.mjs','utf8'))[1];
Object.assign(osa, {
  CFBundleName: 'Suno CoverBot Setup',
  CFBundleDisplayName: 'Suno CoverBot Setup',
  CFBundleIdentifier: 'io.sslip.sunocoverbot.setup',
  CFBundleURLTypes: [{
    CFBundleURLName: 'Suno CoverBot Setup',
    CFBundleURLSchemes: ['scbsetup', 'scbhelper'],
  }],
  CFBundleShortVersionString: version,
  CFBundleVersion: version,
  LSMinimumSystemVersion: '12.0',
});
writeFileSync(process.env.OUT + '/merged-info.json', JSON.stringify(osa));
NODE
plutil -convert xml1 -o "$BUNDLE/Contents/Info.plist" "$OUT/merged-info.json"

echo "== 6/8: inject SEA into core binary =="
CORE="$BUNDLE/Contents/Resources/$CORE_NAME"
cp "$(command -v node)" "$CORE"
chmod +x "$CORE"
codesign --remove-signature "$CORE" 2>/dev/null || true
npx --yes --prefix "$TOOLS" postject "$CORE" NODE_SEA_BLOB "$OUT/setup-tool.blob" \
  --sentinel-fuse "$FUSE" \
  --macho-segment-name NODE_SEA

echo "== 7/8: sign candidate + tar.gz =="
if [[ -n "${SCB_MAC_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp --entitlements "$ROOT/config/setup-mac-entitlements.plist" --sign "$SCB_MAC_SIGN_IDENTITY" "$CORE"
  codesign --force --options runtime --timestamp --sign "$SCB_MAC_SIGN_IDENTITY" "$BUNDLE"
  codesign --verify --deep --strict "$BUNDLE"
  if [[ -n "${SCB_MAC_NOTARY_PROFILE:-}" ]]; then
    ditto -c -k --keepParent "$BUNDLE" "$OUT/notarize.zip"
    xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$SCB_MAC_NOTARY_PROFILE" --wait
    xcrun stapler staple "$BUNDLE"
    xcrun stapler validate "$BUNDLE"
    spctl --assess --type execute "$BUNDLE"
  else
    echo "UNVERIFIED: Developer ID present, notarization not performed."
  fi
else
  codesign --force --deep --sign - "$BUNDLE"
  echo "UNVERIFIED: ad-hoc test candidate only; Developer ID signing/notarization is required before distribution."
fi
# COPYFILE_DISABLE keeps AppleDouble (._*) entries and extended attributes out of the archive.
COPYFILE_DISABLE=1 tar -czf "$PUBLIC_PKG" -C "$OUT" "$APP_NAME.app"

echo "== 8/8: sha256 =="
(cd "$(dirname "$PUBLIC_PKG")" && shasum -a 256 "$(basename "$PUBLIC_PKG")" | tee "$(basename "$PUBLIC_PKG").sha256")
echo "Built $PUBLIC_PKG"
export PUBLIC_PKG
node --input-type=module <<'NODE'
import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {ROOT,OUT,PUBLIC_PKG}=process.env;
const {componentSourceIdentity}=await import(pathToFileURL(ROOT+'/scripts/update-control/source-identity.mjs'));
const {buildPublicTrust}=await import(pathToFileURL(ROOT+'/scripts/update-control/public-keys.mjs'));
const hash=createHash('sha256').update(readFileSync(PUBLIC_PKG)).digest('hex');
const name='SunoCoverBotSetup-mac-'+process.arch+'-'+hash.slice(0,16)+'.tar.gz';
copyFileSync(PUBLIC_PKG,ROOT+'/scratch/release-candidates/'+name);
const version=/TOOL_VERSION = '([\d.]+)'/.exec(readFileSync(ROOT+'/scripts/setup-tool/main.mjs','utf8'))[1];
writeFileSync(OUT+'/component.json',JSON.stringify({component_type:'macos-setup',platform:'macos',architecture:process.arch,version,artifact_path:'/'+name,artifact_hash:hash,...componentSourceIdentity('setup',buildPublicTrust()),api_contract:1,schema_min:1,schema_max:1},null,2)+'\n');
NODE
