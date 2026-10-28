// Suno CoverBot Setup: the standalone Windows tool behind the download icon on the connect page. Node is inside the EXE, so the
// user installs nothing else. Double-click shows the designed setup window and everything runs behind it, fully automatic:
// download + verify the extension, write its folder, register the quiet updater, load + pin it in Chrome, then follow the
// Suno connection. No terminal window, no PowerShell, no OTP here (identity is checked once, on the website). It never evaluates
// downloaded code; it only downloads the PUBLIC extension ZIP and verifies it before writing a single file.
//
//   SunoCoverBotSetup.exe              the setup window (default)
//   SunoCoverBotSetup.exe --update     what the scheduled task runs, hidden: install the published version if newer
//   SunoCoverBotSetup.exe --launch scbsetup://run   what the website's link opens: same as the default window; the link's content is ignored
//   SunoCoverBotSetup.exe --uninstall  remove the updater task, the scbsetup:// link type and their files (the extension folder is left alone)
//   SunoCoverBotSetup.exe --selftest-file <path>   write the build identity to a file; changes nothing
//   SunoCoverBotSetup.exe --status-file <path>     write the update health (installed vs published version, task, last log lines); changes nothing
//   flags: --no-chrome (skip the Chrome steps)  --headless (run the pipeline without a window; progress goes to setup.log)
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { installPackage, installedVersion } from '../setup-pilot/install-package.mjs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { unregisterUpdater, currentSid, taskNameFor } from '../setup-pilot/scheduler.mjs';
import { unregisterProtocol } from './protocol.mjs';
import { BASE, fetchPublicRelease, fetchReleaseMeta, isNewerVersion } from './lib.mjs';
import { createEngine, needsUserWindow } from './engine.mjs';
import { createUiServer } from './ui-server.mjs';
import { pickLanguage } from './copy.mjs';
import { launchWindow } from './window.mjs';
import { loadAssets } from './assets.mjs';
import { closeCdp, ensureAutoAllow, runCdpBridge } from './chrome.mjs';
import { unregisterLaunchAgent, agentStatus } from './launchagent.mjs';

import { managedUpdate } from './managed-update.mjs';
import {RELEASE_PUBLIC_KEY,ACTION_PUBLIC_KEY} from './update-control.mjs';

export const TOOL_VERSION = '2.3.0';
// The trusted extension public key is baked in at build time (esbuild --define); the env var is for development runs only.
const KEY = typeof __SCB_KEY__ === 'string' ? __SCB_KEY__ : (process.env.SCB_SETUP_KEY || '');
// SCB_SETUP_HOME exists for tests (the update verification runs the real EXE in a sandbox folder); normal runs never set it.
function defaultSetupHome() {
  if (process.env.SCB_SETUP_HOME) return process.env.SCB_SETUP_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SunoCoverBot', 'setup');
  return path.join(os.homedir(), '.local', 'share', 'SunoCoverBot', 'setup');
}
const HOME = defaultSetupHome();
const flag = name => process.argv.includes('--' + name);
const argValue = name => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; };
const log = (file, text) => { try { mkdirSync(HOME, { recursive: true }); appendFileSync(path.join(HOME, file), `[${new Date().toISOString().slice(0, 19)}] ${text}\n`); } catch { /* logging never fails a run */ } };

async function update({ reloadChrome = true } = {}) {
  const config = JSON.parse(readFileSync(path.join(HOME, 'updater.json'), 'utf8').replace(/^\uFEFF/, ''));
  return managedUpdate({ home: HOME, config, toolVersion: TOOL_VERSION, reloadChrome, log });
}

async function statusReport() {
  const read = file => { try { return readFileSync(path.join(HOME, file), 'utf8').replace(/^﻿/, ''); } catch { return ''; } };
  let config = null; try { config = JSON.parse(read('updater.json')); } catch { /* not installed */ }
  const installed = config ? installedVersion(config.directory) : null;
  const meta = config ? await fetchReleaseMeta({ base: config.base }).catch(() => null) : null;
  let task = null;
  if (process.platform === 'darwin') task = agentStatus();
  else try {
    const text = execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'schtasks.exe'), ['/Query', '/TN', taskNameFor(currentSid()), '/FO', 'LIST', '/V'], { encoding: 'utf8', windowsHide: true });
    const pick = key => text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? null;
    task = { status: pick('Status'), lastRun: pick('Last Run Time'), lastResult: pick('Last Result'), nextRun: pick('Next Run Time') };
  } catch { /* task missing */ }
  return { tool: TOOL_VERSION, installedVersion: installed, publishedVersion: meta?.version ?? null,
    upToDate: null, runningVersion: null, verifiedVersion: null, runtimeVerification: 'INDEPENDENT_HEARTBEAT_REQUIRED', task, lastUpdateLog: read('update.log').trim().split(String.fromCharCode(10)).map(l => l.replace(String.fromCharCode(13), '')).slice(-3) };
}

function uninstall() {
  const removed = process.platform === 'darwin' ? unregisterLaunchAgent() : unregisterUpdater();
  unregisterProtocol();
  for (const name of ['updater.json', 'update-launch.vbs', 'scb-updater-task.xml', 'update.log', 'cdp-bridge.ready']) rmSync(path.join(HOME, name), { force: true });
  log('setup.log', `uninstall: updater task removed=${removed}`);
}

async function runWindow() {
  if (!KEY) throw new Error('This build has no extension key baked in.');
  ensureAutoAllow();
  // One window at a time: a second launch (a double click, or the website opening the tool again) simply exits. The fixed loopback
  // port is only a lock; nothing is served on it.
  let showWindow = () => null;
  if (!flag('headless')) {
    const lock = net.createServer(sock => { sock.on('error', () => {}); try { showWindow(); sock.end(); } catch {} });
    const free = await new Promise(resolve => { lock.once('error', () => resolve(false)); lock.listen(47831, '127.0.0.1', () => resolve(true)); });
    if (!free) {
      try { const c = net.connect(47831, '127.0.0.1', () => c.end()); c.on('error', () => {}); } catch {}
      log('setup.log', 'already running; second launch focused existing window');
      return;
    }
  }
  let windowChild = null;
  let closingForReturn = false;
  const closeWindowOnly = () => {
    closingForReturn = true;
    try { windowChild?.kill(); } catch { /* already closed */ }
  };
  const finish = () => { closeCdp(); closeWindowOnly(); process.exit(0); };
  const initialReleaseId=argValue('initial-release-id');
  const deps=initialReleaseId?{fetchPublicRelease:async options=>fetchPublicRelease({...options,meta:await fetchReleaseMeta({initialReleaseId})})}:{};
  const engine = createEngine({ key: KEY, home: HOME, deps, skipChrome: flag('no-chrome'), autoReturn: !flag('no-chrome') && !flag('headless'), onBeforeReturn: closeWindowOnly, onDone: finish });
  if (flag('headless')) { await engine.run(); log('setup.log', JSON.stringify(engine.snapshot())); process.exitCode = engine.state.phase === 'done' ? 0 : 1; return; }
  const ui = createUiServer({ engine, assets: loadAssets(), onClose: finish });
  const url = (await ui.listen()) + '&lang=' + pickLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  let child = null;
  showWindow = () => {
    if (child && child.exitCode === null && !child.killed) return child;
    closingForReturn = false;
    child = launchWindow({ url, profileDir: path.join(HOME, 'window-profile') });
    windowChild = child;
    child?.on('exit', () => { if (!closingForReturn) process.exit(0); });
    return child;
  };
  showWindow();
  if (!child) { log('setup.log', 'no Chrome or Edge found; running without a window'); await engine.run(); process.exit(engine.state.phase === 'done' ? 0 : 1); }
  setTimeout(() => process.exit(0), 60 * 60_000).unref();
  engine.run().catch(error => log('setup.log', 'engine crashed: ' + (error?.message || error)));
}

function launchAction() {
  // --launch scbsetup://update  OR  --launch scbhelper://update  OR  argv containing the URL
  const raw = argValue('launch') || process.argv.find((a) => /^(scbsetup|scbhelper):\/\//i.test(a)) || '';
  const m = /^(?:scbsetup|scbhelper):\/\/(run|install|update)\/?/i.exec(String(raw).trim());
  if (m) return m[1].toLowerCase();
  if (flag('update')) return 'update';
  if (flag('launch')) return 'run';
  return null;
}

async function main() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('Windows or macOS only.');
  const selftest = argValue('selftest-file');
  if (selftest) { writeFileSync(selftest, JSON.stringify({ tool: TOOL_VERSION, keySha256: createHash('sha256').update(KEY).digest('hex').slice(0, 16), base: BASE, platform: process.platform,releaseTrustConfigured:!!RELEASE_PUBLIC_KEY,actionTrustConfigured:!!ACTION_PUBLIC_KEY,releaseKeyHash:createHash('sha256').update(RELEASE_PUBLIC_KEY).digest('hex'),actionKeyHash:createHash('sha256').update(ACTION_PUBLIC_KEY).digest('hex') })); return; }
  const statusFile = argValue('status-file');
  if (statusFile) { writeFileSync(statusFile, JSON.stringify(await statusReport(), null, 2)); return; }
  if (flag('cdp-bridge')) {
    if (process.platform !== 'win32') throw new Error('cdp-bridge is Windows-only for now.');
    ensureAutoAllow(); await runCdpBridge(); return;
  }
  const action = launchAction();
  if (action === 'update' || flag('update')) {
    try { await update({ reloadChrome: !flag('no-chrome') }); }
    catch (error) { log('update.log', 'FAILED: ' + error.message); process.exitCode = 1; }
    if (process.platform === 'darwin') { closeCdp(); process.exit(process.exitCode ?? 0); }
    return;
  }
  if (flag('uninstall')) { uninstall(); return; }
  await runWindow();
}
if (!process.env.SCB_SETUP_NO_AUTORUN) main().catch(error => { log('setup.log', 'FAILED: ' + (error?.message || error)); process.exitCode = 1; });
