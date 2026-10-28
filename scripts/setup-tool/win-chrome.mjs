// Windows: put the extension into the user's REAL Chrome with no manual step (owner, 2026-10-26: "this must be automatic").
//
// Why this exists: the tool drives Chrome over its debugging port, and Chrome only opens that port when the user has turned on
// chrome://inspect/#remote-debugging ("Allow remote debugging for this browser instance"). That switch is a single preference in
// Chrome's `Local State` file (devtools.remote_debugging.user-enabled). The owner's Chrome has it on, which is why the tool works there;
// a tester's Chrome (reported 2026-10-26: setup steps 1-3 green, step 4 on "open chrome://extensions, Developer mode, Load unpacked")
// does not, so `loadIntoChrome` fails with `debugging_off` and the tool falls back to a manual instruction.
// MEASURED on real Chrome 155 (throwaway profile): with that one preference written in `Local State` and NO command-line flag, Chrome
// writes DevToolsActivePort within ~3 s of starting; without it, no port at all. So, once, at first install only:
//   1. close the user's Chrome the way Windows does at log-off (an end-session message, never a kill: Chrome saves ALL its windows),
//   2. set the preference in `Local State` (Chrome rewrites that file from memory on exit, so it can only be edited while it is closed),
//   3. start Chrome again with `--restore-last-session` (windows and tabs come back),
//   4. load + pin through the tool's normal Chrome step (its consent dialog is answered by the tool's auto-clicker).
// The preference is left on ON PURPOSE: it is what lets the 15-minute updater reload the extension after an update. Everything else is
// left as found. Any doubt (no Chrome, unreadable Local State, Chrome refusing to close, no port) ends in the manual step, and a failed
// attempt leaves a marker so the user's Chrome is never restarted twice for nothing.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadIntoChrome } from './chrome.mjs';
import { chromeInstalls } from './lib.mjs';

const userDataDir = () => path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const setupDir = () => path.join(process.env.LOCALAPPDATA || '', 'SunoCoverBot', 'setup');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const MARKER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Google Chrome only (the extension is installed there, not into Edge). */
export function findChrome(env = process.env, exists = existsSync) {
  const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(file => exists(file)) || null;
}

/**
 * Main processes of the USER's Chrome out of `[{ProcessId, CommandLine}]`. Not picked: renderer/gpu/utility helpers (`--type=`), the setup
 * window (also a Chrome, with its own --user-data-dir under `windowProfile`) and any Chrome running on another profile folder (automation,
 * dev tools): those are not the user's browser and are never closed.
 */
export function userChromePids(processes, { userData = userDataDir(), windowProfile = path.join(setupDir(), 'window-profile') } = {}) {
  const pids = [];
  for (const p of processes || []) {
    const command = String(p?.CommandLine || '');
    if (!command || /\s--type=/.test(command)) continue;
    const given = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(command);
    const dir = given ? (given[1] ?? given[2]) : null;
    if (dir && (same(dir, windowProfile) || !same(dir, userData))) continue;
    if (!given && !same(userData, userDataDir())) continue; // a flag-less Chrome is on the default folder, which is only "the user's" when we are working on the default folder
    pids.push(Number(p.ProcessId));
  }
  return pids;
}

const PS_LIST = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
function listProcesses(d) {
  const out = String(d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// How Chrome is closed (MEASURED on real Chrome 155, a profile with two windows holding /a,/b and /c, then `--restore-last-session`):
//   taskkill /PID (no /F)   closes ONE window per call; closing them one by one leaves only the LAST one in the saved session -> restored /a,/b, window /c LOST
//   chrome://quit           ignored by release builds, Chrome stays up
//   WM_QUERYENDSESSION + WM_ENDSESSION to its windows (what Windows sends at log-off/shutdown) -> Chrome exits by itself and saves EVERY window:
//                           restored /c,/a,/b, exit_type "SessionEnded" (what a normal Windows shutdown leaves, no crash bubble).
// So that is what is sent, only to the windows of the USER's Chrome main process. Never a kill.
const END_SESSION_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  public static List<IntPtr> Of(HashSet<uint> pids) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (pids.Contains(p) && IsWindowVisible(h)) { var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64); if (sb.ToString() == "Chrome_WidgetWin_1") list.Add(h); } return true; }, IntPtr.Zero);
    return list;
  }
}
"@
$set = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($p in $pids) { [void]$set.Add([uint32]$p) }
$wins = [W]::Of($set)
$closeApp = [IntPtr]1
foreach ($h in $wins) { $r = [IntPtr]::Zero; [void][W]::SendMessageTimeout($h, 0x11, [IntPtr]::Zero, $closeApp, 2, 5000, [ref]$r) }
foreach ($h in $wins) { $r = [IntPtr]::Zero; [void][W]::SendMessageTimeout($h, 0x16, [IntPtr]1, $closeApp, 2, 5000, [ref]$r) }
$wins.Count
`;
const encodePs = script => Buffer.from(script, 'utf16le').toString('base64');
export const endSessionCommand = pids => encodePs(`$pids = @(${pids.map(Number).filter(Number.isInteger).join(',')})\n${END_SESSION_PS}`);

async function quit(pids, d) {
  d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', endSessionCommand(pids)], { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const until = Date.now() + d.quitMs;
  while (Date.now() < until) {
    if (userChromePids(listProcesses(d), d).filter(pid => pids.includes(pid)).length === 0) return true;
    await d.sleep(d.retryMs);
  }
  return false;
}

/** Sets devtools.remote_debugging.user-enabled in the Local State text, leaving every other key as it was. */
export function withRemoteDebuggingOn(text) {
  const state = JSON.parse(String(text).replace(/^﻿/, ''));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('local_state_not_an_object');
  if (state.devtools?.remote_debugging?.['user-enabled'] === true) return null;
  state.devtools = { ...(state.devtools || {}), remote_debugging: { ...(state.devtools?.remote_debugging || {}), 'user-enabled': true } };
  return JSON.stringify(state);
}

let attempted = false;
export const resetWinChromeAttempt = () => { attempted = false; };

/**
 * @returns {{ok:boolean, version?:string, reason?:string, relaunched?:boolean}} same shape as loadIntoChrome.
 * `deps` exists for the tests: every process, file and sleep is injectable. `onRestart` is called just before Chrome is closed so the window can say so.
 */
export async function loadIntoChromeWin(directory, { expectedVersion = null, onRestart = () => {}, deps = {} } = {}) {
  const userData = deps.userData || userDataDir();
  const d = {
    run: execFileSync, sleep: ms => new Promise(r => setTimeout(r, ms)), loadIntoChrome, chromeInstalls,
    exists: existsSync, mkdir: mkdirSync, rm: rmSync, readFile: p => readFileSync(p, 'utf8'), writeFile: writeFileSync, rename: renameSync, copy: copyFileSync,
    spawnChrome: (bin, args) => { const c = spawn(bin, args, { detached: true, stdio: 'ignore' }); c.unref(); return c; },
    chrome: findChrome(), launchArgs: [], marker: path.join(setupDir(), 'chrome-relaunch-failed.json'), now: Date.now,
    userData, windowProfile: path.join(setupDir(), 'window-profile'), warnMs: 3_000, quitMs: 20_000, retryMs: 500, portMs: 25_000, ...deps,
  };

  const first = await d.loadIntoChrome(directory, { expectedVersion });
  if (first.ok) return first;
  // Only "Chrome has no debugging port" is fixed here. A consent dialog still pending, a dropped connection or a failed load keep the normal loop.
  if (first.reason !== 'debugging_off' || attempted) return first;

  // Already installed from this very folder (a manual install, or an earlier run): never restart Chrome for nothing.
  if (d.chromeInstalls(d.userData).some(c => same(c.path, directory))) return first;

  // A previous attempt got no debugging port even with the preference set: the manual step is the only way here, do not restart Chrome again.
  try {
    const m = JSON.parse(d.readFile(d.marker));
    if (m?.reason === 'debug_port_missing' && d.now() - Number(m.at || 0) < MARKER_TTL_MS) return { ok: false, reason: 'relaunch_disabled' };
  } catch { /* no marker */ }

  // Everything that can fail is checked BEFORE anything is closed: never close the user's Chrome when we cannot start it again.
  attempted = true;
  if (!d.chrome || !d.exists(d.chrome)) return { ok: false, reason: 'chrome_not_found' };
  const statePath = path.join(d.userData, 'Local State');
  let patched;
  try { patched = withRemoteDebuggingOn(d.readFile(statePath)); } catch { return { ok: false, reason: 'local_state_unreadable' }; }
  let running;
  try { running = userChromePids(listProcesses(d), d); } catch { return { ok: false, reason: 'process_list_failed' }; }

  if (running.length) {
    try { onRestart(); } catch { /* display only */ }
    await d.sleep(d.warnMs); // let the person read that Chrome restarts once
    if (!(await quit(running, d))) return { ok: false, reason: 'chrome_did_not_quit' };
  }

  // Chrome is closed: its Local State is ours to edit. Written beside the file and renamed over it so a crash never leaves a half file.
  if (patched !== null) {
    try {
      try { if (!d.exists(statePath + '.scb-backup')) d.copy(statePath, statePath + '.scb-backup'); } catch { /* a backup is a courtesy */ }
      d.writeFile(statePath + '.scb-new', patched);
      d.rename(statePath + '.scb-new', statePath);
    } catch (error) {
      if (running.length) { try { d.spawnChrome(d.chrome, [...d.launchArgs, '--restore-last-session']); } catch { /* the user reopens Chrome */ } }
      return { ok: false, reason: 'local_state_write_failed:' + (error?.message || error) };
    }
  }

  const portFile = path.join(d.userData, 'DevToolsActivePort');
  d.rm(portFile, { force: true }); // a stale file from an earlier run would point at a dead port
  try { d.spawnChrome(d.chrome, [...d.launchArgs, '--restore-last-session', '--no-first-run', '--no-default-browser-check']); }
  catch (error) { return { ok: false, reason: 'chrome_start_failed:' + (error?.message || error) }; }
  const portUntil = Date.now() + d.portMs;
  while (Date.now() < portUntil && !d.exists(portFile)) await d.sleep(200);

  if (!d.exists(portFile)) {
    try { d.mkdir(path.dirname(d.marker), { recursive: true }); d.writeFile(d.marker, JSON.stringify({ reason: 'debug_port_missing', at: d.now() })); } catch { /* best effort */ }
    return { ok: false, reason: 'debug_port_missing', relaunched: true };
  }
  const result = await d.loadIntoChrome(directory, { expectedVersion });
  if (result.ok) await d.sleep(1_500); // give Chrome a moment to persist the extension and its toolbar pin
  return { ...result, relaunched: true };
}
