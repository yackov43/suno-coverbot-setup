// The setup pipeline behind the window. Pure orchestration over injectable dependencies, so every branch is testable
// without Windows, a network or a browser. The window only ever READS this state; it never decides anything.
import { copyFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installPackage, writeMarker, installedVersion } from '../setup-pilot/install-package.mjs';
import { launcherScript, registerUpdater } from '../setup-pilot/scheduler.mjs';
import { BASE, chromeInstalls, fetchPublicRelease } from './lib.mjs';
import { loadIntoChrome, connectedTabIds } from './chrome.mjs';
import { registerProtocol } from './protocol.mjs';
import { registerLaunchAgent } from './launchagent.mjs';
import { loadIntoChromeMac } from './mac-chrome.mjs';
import { loadIntoChromeWin } from './win-chrome.mjs';
import { returnToTelegram } from './telegram.mjs';
import { acquireComponentLock, bindNativeMarker, retireLegacyScheduler } from './update-control.mjs';

export const STEP_IDS = ['download', 'files', 'updates', 'chrome', 'suno'];
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function createEngine({ key, home, exePath = process.execPath, skipChrome = false, autoReturn = false, onBeforeReturn = () => {}, onDone = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)),
  deps = {}, limits = {} } = {}) {
  const d = { acquireComponentLock, bindNativeMarker, retireLegacyScheduler, fetchPublicRelease, installPackage, writeMarker, installedVersion, registerUpdater, registerProtocol, registerLaunchAgent, returnToTelegram, loadIntoChrome: process.platform === 'darwin' ? loadIntoChromeMac : process.platform === 'win32' ? loadIntoChromeWin : loadIntoChrome, connectedTabIds, chromeInstalls,
    copyFile: copyFileSync, mkdir: mkdirSync, write: writeFileSync, exists: existsSync, ...deps };
  const L = { chromePermissionMs: 180_000, chromeManualMs: 600_000, pairingMs: 1_800_000, pollMs: 400, sunoPollMs: 350, ...limits };
  const state = { returnedVia: '', phase: 'idle', steps: STEP_IDS.map(id => ({ id, status: 'pending', detail: '' })), folder: '', version: '', error: '' };
  const set = (id, status, detail = '') => { const s = state.steps.find(x => x.id === id); s.status = status; s.detail = detail; };
  let running = false;

  async function chromeStep(folder) {
    if (skipChrome) { set('chrome', 'done', 'skipped'); return true; }
    const started = Date.now();
    for (;;) {
      set('chrome', 'running');
      const r = await d.loadIntoChrome(folder, { expectedVersion: state.version, onRestart: () => set('chrome', 'running', 'restart') });
      if (r.ok) { set('chrome', 'done'); return true; }
      const manual = r.reason !== 'permission_pending';
      set('chrome', 'action', manual ? 'manual' : 'permission');
      if (manual && process.platform !== 'darwin' && d.chromeInstalls().some(c => same(c.path, folder))) { set('chrome', 'done', 'manual'); return true; }
      if (Date.now() - started > (manual ? L.chromeManualMs : L.chromePermissionMs)) return false;
      await sleep(L.pollMs);
    }
  }

  // Watches for a NEW success tab from the very start of the run (the user may finish connecting while files are still installing, and
  // that page lives only ~2.5 s). Tabs already open at the start are remembered and ignored: they are leftovers, not this connection.
  let connectedSeen = false, watching = false;
  async function startWatcher() {
    connectedSeen = false;
    if (skipChrome) return;
    const baseline = new Set((await d.connectedTabIds()) || []);
    watching = true;
    void (async () => {
      while (watching) {
        const now = await d.connectedTabIds();
        if (now && now.some(id => !baseline.has(id))) connectedSeen = true;
        await sleep(L.sunoPollMs ?? 400);
      }
    })();
  }

  async function run() {
    if (running) return; running = true;
    let releaseLock = null;
    await startWatcher();
    Object.assign(state, { phase: 'running', error: '' });
    try {
      set('download', 'running');
      const { release, bytes } = await d.fetchPublicRelease({ key });
      state.version = release.version; set('download', 'done');

      set('files', 'running');
      const folder = d.chromeInstalls()[0]?.path || path.join(os.homedir(), 'Documents', 'SunoCoverBot', 'extension');
      // A per-user scheduler currently owns one directory. Preserve its existing scope on a conflicting migration.
      // The folder Chrome actually loads is the one to keep current: when the extension was loaded by hand from another
      // folder, the updater moves to it (updater.json is rewritten below) instead of refusing the whole setup.
      try{const previous=JSON.parse(readFileSync(path.join(home,'updater.json'),'utf8'));if(previous.directory&&!same(previous.directory,folder))state.movedFrom=previous.directory;}catch{}
      releaseLock = await d.acquireComponentLock(folder);
      state.folder = folder;
      d.mkdir(home, { recursive: true });
      const toolBinary = process.platform === 'darwin' ? 'SunoCoverBotSetup-core' : 'SunoCoverBotSetup.exe';
      const exe = path.join(home, toolBinary);
      if (!same(exePath, exe)) {
        try { rmSync(exe + '.old', { force: true }); } catch {}
        try { if (existsSync(exe)) renameSync(exe, exe + '.old'); } catch {}
        d.copyFile(exePath, exe);
        try { rmSync(exe + '.old', { force: true }); } catch {}
      }
      try { unlinkSync(exe + ':Zone.Identifier'); } catch (e) {}
      try { unlinkSync(exePath + ':Zone.Identifier'); } catch (e) {}
      // macOS: URL schemes live on the .app Info.plist. If we launched from a
      // DMG/.app, install that .app into ~/Applications so scbsetup:// keeps working
      // after the DMG is ejected (core binary alone is not enough).
      if (process.platform === 'darwin') {
        const appMatch = String(exePath).match(/^(.*\.app)(?=\/Contents\/)/i);
        if (appMatch) {
          const srcApp = appMatch[1];
          const destApp = path.join(os.homedir(), 'Applications', 'SunoCoverBotSetup.app');
          try {
            d.mkdir(path.dirname(destApp), { recursive: true });
            if (!same(srcApp, destApp)) {
              try { rmSync(destApp, { recursive: true, force: true }); } catch {}
              try { execFileSync('ditto', [srcApp, destApp], { stdio: 'ignore' }); }
              catch {
                try { execFileSync('cp', ['-R', srcApp, destApp], { stdio: 'ignore' }); } catch {}
              }
              try {
                execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', destApp], { stdio: 'ignore' });
              } catch { /* best-effort */ }
            }
          } catch { /* app install best-effort; core + updater.json still enable detection */ }
        }
      }
      d.write(path.join(home, 'updater.json'), JSON.stringify({ base: BASE, directory: folder, key }, null, 2));
      d.installPackage(bytes, release, { key, directory: folder, previousVersion: d.installedVersion(folder), registered: false });
      set('files', 'done');

      set('updates', 'running');
      if (process.platform === 'win32') {
        const launcher = path.join(home, 'update-launch.vbs');
        d.write(launcher, launcherScript(exe, '--update'));
        d.registerUpdater({ directory: home, launcherPath: launcher });
        d.registerProtocol(exe); // lets the website open this tool next time (scbsetup://)
      }
      // darwin: scbsetup:// / scbhelper:// come from the .app Info.plist (build-mac.sh); the quiet updater is a per-user
      // LaunchAgent running `core --update`. A Mac where launchd refuses must not block the install, so the failure is
      // recorded on the step instead of thrown (the status report shows it).
      let agentDetail = '';
      if (process.platform === 'darwin') {
        try {
          const agent = d.registerLaunchAgent({ corePath: exe, home });
          if (!agent.loaded || !agent.runsUpdate || !agent.interval) throw new Error('launchagent-verification-failed');
        } catch (error) { agentDetail = 'launchagent-failed: ' + String(error?.message || error).slice(0, 120); }
      }
      if (agentDetail) {
        d.writeMarker(folder, { registered: false, previousVersion: release.version, targetVersion: release.version });
        set('updates', 'error', agentDetail); state.phase = 'failed'; state.error = 'MAC_LAUNCHAGENT_FAILED'; return;
      }
      d.writeMarker(folder, { registered: true, previousVersion: release.version, targetVersion: release.version });
      d.bindNativeMarker(home, folder);
      if (process.platform === 'win32'&&!d.chromeInstalls().some(c=>!same(c.path,folder))) d.retireLegacyScheduler();
      set('updates', 'done', agentDetail);

      if (!(await chromeStep(folder))) { state.phase = 'failed'; state.error = 'chrome'; return; }

      set('suno', 'running');
      const started = Date.now();
      for (;;) {
        const paired = connectedSeen ? true : null;
        if (paired === true) { set('suno', 'done'); break; }
        set('suno', 'action', 'waiting');
        if (skipChrome || Date.now() - started > L.pairingMs) break;
        await sleep(L.sunoPollMs ?? L.pollMs); // fast: the success page only stays open for ~2.5 s before it redirects
      }
      state.phase = state.steps.every(s => s.status === 'done') ? 'done' : 'waiting';
      if (state.phase === 'done' && autoReturn) {
        // Show all 5 completed steps in the front Setup Component window for a moment, then close the Setup window,
        // return the user to Telegram (keeping Chrome open), and end the tool.
        await sleep(L.closeMs ?? 1_200);
        try { onBeforeReturn(); } catch {}
        const back = await d.returnToTelegram().catch(() => ({ via: 'none' }));
        state.returnedVia = back.via;
        setTimeout(onDone, L.closeMs !== undefined ? L.closeMs : 150);
      }
    } catch (error) {
      state.phase = 'failed'; state.error = String(error?.message || error);
      const active = state.steps.find(s => s.status === 'running'); if (active) set(active.id, 'error', String(error?.code || error?.message || error).slice(0, 160));
    } finally { if (releaseLock) await releaseLock(); running = false; watching = false; }
  }
  function retry() { if (state.phase === 'failed' || state.phase === 'waiting') { for (const s of state.steps) if (s.status !== 'done') set(s.id, 'pending'); return run(); } }
  return { state, run, retry, snapshot: () => structuredClone(state) };
}

/** A silent run (opened by the website) shows its window only when something needs the user: a failure, or a Chrome step that needs a click. */
export function needsUserWindow(state) {
  return state.phase === 'failed' || state.steps.some(s => s.status === 'action' && (s.detail === 'permission' || s.detail === 'manual'));
}
