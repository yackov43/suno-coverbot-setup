// Opens the setup window as a plain app window of the installed Chrome (or Edge, which every Windows 10/11 PC has), in its own
// throwaway profile so it never touches the user's browser profile. The window is only a display; closing it ends the tool.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function findBrowser(env = process.env, exists = existsSync) {
  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return macCandidates.find(file => exists(file)) || null;
  }
  const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map(r => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
  return candidates.find(file => exists(file)) || null;
}

export function windowArgs({ url, profileDir, debugPort = 0 }) {
  return [`--app=${url}`, `--user-data-dir=${profileDir}`, '--window-size=540,860', '--window-position=60,60', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-features=Translate', ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : [])];
}

export function launchWindow({ url, profileDir, browser = findBrowser(), debugPort = Number(process.env.SCB_UI_DEBUG_PORT) || 0 }) {
  if (!browser) return null;
  return spawn(browser, windowArgs({ url, profileDir, debugPort }), { stdio: 'ignore', windowsHide: false });
}
