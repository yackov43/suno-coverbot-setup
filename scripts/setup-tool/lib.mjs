// Shared by the owner CLI (scripts/setup-pilot/owner-install.mjs) and the packaged setup tool (scripts/setup-tool/main.mjs).
// Pure helpers: no module-level side effects, so they are safe to bundle into the standalone EXE.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { verifyPackage } from '../setup-pilot/core.mjs';
import { approvedComponent } from './update-control.mjs';

// In the packaged EXE the server address is fixed at build time (esbuild --define); the env override exists for development only.
export const BASE = typeof __SCB_BASE__ === 'string' ? __SCB_BASE__ : (process.env.SCB_PILOT_BASE || 'https://46-225-2-111.sslip.io');

/** HTTPS only (loopback http is allowed solely for the local update test). */
export function assertSafeBase(base) {
  const url = new URL(base);
  const loopbackTest = process.env.SCB_UPDATER_TEST === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopbackTest) throw new Error('requires_https');
}
export const EXTENSION_ID = 'geokjdngpomhdgjamobhgokjgphnjaed';

/** Chrome profiles whose Preferences list the extension (read-only): where it is loaded from and whether it is pinned. */
function defaultChromeUserData() {
  if (process.platform === 'darwin') return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  return path.join(process.env.HOME || '', '.config', 'google-chrome');
}
export function chromeInstalls(userData = defaultChromeUserData()) {
  if (!existsSync(userData)) return [];
  const found = [];
  for (const entry of readdirSync(userData, { withFileTypes: true })) {
    if (!entry.isDirectory() || !(entry.name === 'Default' || /^Profile \d+$/.test(entry.name))) continue;
    let installPath = null, pinned = false, developerMode = null;
    for (const file of ['Secure Preferences', 'Preferences']) {
      try {
        const prefs = JSON.parse(readFileSync(path.join(userData, entry.name, file), 'utf8'));
        installPath ||= prefs.extensions?.settings?.[EXTENSION_ID]?.path || null;
        pinned ||= (prefs.extensions?.pinned_extensions || []).includes(EXTENSION_ID);
        // A protected pref: real Chrome keeps it in Secure Preferences (measured 2026-10-28), so that file wins.
        if (developerMode === null && typeof prefs.extensions?.ui?.developer_mode === 'boolean') developerMode = prefs.extensions.ui.developer_mode;
      } catch { /* profile without that file */ }
    }
    if (installPath) found.push({ profile: entry.name, path: installPath, pinned, developerMode });
  }
  return found;
}

/** Chrome profiles that load `directory` while developer mode is off (or was never switched on). Measured 2026-10-28:
 * an unpacked extension that reloads there comes back disabled ("unsupportedDeveloperExtension") and never reports again. */
export function developerModeOffProfiles(directory, userData) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return chromeInstalls(userData).filter(c => same(c.path, directory) && c.developerMode !== true).map(c => c.profile);
}

export async function fetchReleaseMeta({ base = BASE, fetchImpl = fetch, initialReleaseId = null } = {}) {
  assertSafeBase(base);
  if(initialReleaseId&&!/^[A-Za-z0-9._-]{8,100}$/.test(initialReleaseId))throw Error('invalid_release_id');
  const response = await fetchImpl(`${base}/api/update-control/public-release?c=${Date.now()}${initialReleaseId?'&release_id='+encodeURIComponent(initialReleaseId):''}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('no_approved_release');
  const meta = approvedComponent(await response.json());
  if (!/^[a-f0-9]{64}$/.test(meta.sha256 || '') || !/^\/scb-extension-[a-f0-9]{16}\.zip$/.test(meta.url || '') || !/^\d+(\.\d+){1,3}$/.test(meta.version || '')) throw new Error('invalid_release_metadata');
  return meta;
}

/**
 * Fetches the published release and checks it before anything is written: metadata shape, size, SHA-256 against the metadata,
 * and (via core.verifyPackage) ZIP structure, no traversal, and that the manifest key/version are the trusted ones.
 */
export async function fetchPublicRelease({ base = BASE, key, fetchImpl = fetch, meta = null } = {}) {
  meta ||= await fetchReleaseMeta({ base, fetchImpl });
  const response = await fetchImpl(base + meta.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200) throw new Error('download_failed');
  const limit=16*1024*1024;
  if(Number(response.headers?.get('content-length'))>limit)throw new Error('package_too_large');
  const chunks=[];let size=0;
  if(response.body){for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('package_too_large');chunks.push(Buffer.from(chunk));}}
  else {const chunk=Buffer.from(await response.arrayBuffer());if(chunk.length>limit)throw new Error('package_too_large');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  verifyPackage(bytes, { sha256: meta.sha256, version: meta.version }, key);
  return { release: { sha256: meta.sha256, version: meta.version }, bytes };
}

const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
export { newer as isNewerVersion };
