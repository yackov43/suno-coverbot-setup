// Takes the user back to Telegram when the setup is complete, in the Telegram they actually use: Telegram Web when a Web tab is open
// in their browser, otherwise Telegram Desktop; when neither Desktop is registered nor a Web tab exists, Telegram Web in the browser.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCdp } from './chrome.mjs';

export const BOT_DOMAIN = 'SunoCoverAgent_bot';
export const SITE = 'https://46-225-2-111.sslip.io';
const sys = name => path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', name);

/** Telegram Desktop registers the tg: link type for the current user (or the machine). */
export function desktopRegistered(run = execFileSync, { platform = process.platform, exists = existsSync } = {}) {
  // macOS has no registry: Telegram Desktop is simply an app bundle.
  if (platform === 'darwin') return ['/Applications', path.join(os.homedir(), 'Applications')].some(dir => ['Telegram.app', 'Telegram Desktop.app'].some(app => exists(path.join(dir, app))));
  for (const hive of ['HKCU', 'HKLM']) {
    try { run(sys('reg.exe'), ['query', String.raw`${hive}\Software\Classes\tg\shell\open\command`, '/ve'], { windowsHide: true, stdio: 'ignore' }); return true; } catch { /* next */ }
  }
  return false;
}

function openLink(url, run = execFileSync, platform = process.platform) {
  // `open` hands the link to the registered handler (Telegram Desktop for tg://, the default browser for https://).
  if (platform === 'darwin') { run('/usr/bin/open', [url], { stdio: 'ignore' }); return; }
  // `start` hands the link to the registered handler; the empty first argument is the window title.
  run(sys('cmd.exe'), ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
}

/**
 * @returns {{ via: 'web-tab' | 'desktop' | 'web-link' | 'none' }}
 * Closes the finished connection tab first (the page would otherwise redirect on its own 2.5 s later and fight this).
 */
export async function returnToTelegram({ open = openCdp, desktop = desktopRegistered, launch = openLink, userData } = {}) {
  let webTab = null;
  try {
    const cdp = await open(userData);
    try {
      const { targetInfos } = await cdp.send('Target.getTargets', {}, undefined, 5_000);
      const pages = (targetInfos || []).filter(x => x.type === 'page');
      const closing = pages.filter(x => x.url.startsWith(`${SITE}/api/connected`));
      if (closing.length > 0 && pages.length <= closing.length) {
        // Prevent closing the entire browser window if the connected tab was the only one open
        await cdp.send('Target.createTarget', { url: 'chrome://newtab/' }, undefined, 5_000).catch(() => {});
      }
      for (const t of closing) await cdp.send('Target.closeTarget', { targetId: t.targetId }, undefined, 5_000).catch(() => {});
      webTab = pages.find(t => /^https:\/\/web\.telegram\.org\//.test(t.url)) || null;
      if (webTab) { await cdp.send('Target.activateTarget', { targetId: webTab.targetId }, undefined, 5_000); return { via: 'web-tab' }; }
    } finally { cdp.close(); }
  } catch { /* Chrome not drivable: fall through to the link handlers */ }
  try {
    if (desktop()) { launch(`tg://resolve?domain=${BOT_DOMAIN}`); return { via: 'desktop' }; }
    launch(`https://web.telegram.org/k/#@${BOT_DOMAIN}`); return { via: 'web-link' };
  } catch { return { via: 'none' }; }
}
