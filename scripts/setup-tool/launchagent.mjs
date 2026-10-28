// macOS twin of the Windows scheduled task (scripts/setup-pilot/scheduler.mjs): a per-user LaunchAgent that runs
// `SunoCoverBotSetup-core --update` at login and every 15 minutes. No admin rights, no helper app, nothing outside ~/Library.
// Pure orchestration over injectable dependencies so every branch is testable without a Mac.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENT_LABEL = 'io.sslip.sunocoverbot.update';
// Same cadence as the Windows task (PT15M).
export const UPDATE_INTERVAL_SECONDS = 900;

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const agentPlistPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);

export function plistFor({ corePath, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(corePath)}</string><string>--update</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${UPDATE_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const launchctl = (run, args) => run('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** What a registered agent must look like; used after registering and by the tests. */
export function describeAgent(printText, corePath) {
  const text = String(printText || '');
  return {
    loaded: text.includes(AGENT_LABEL),
    runsUpdate: text.includes(corePath) && /--update/.test(text),
    interval: new RegExp(`run interval\\s*=\\s*${UPDATE_INTERVAL_SECONDS} seconds`).test(text),
  };
}

export function registerLaunchAgent({ corePath, home, userHome = os.homedir(), uid = process.getuid?.(), run = execFileSync, write = writeFileSync, mkdir = mkdirSync } = {}) {
  if (!corePath || !home) throw new Error('launchagent_args');
  const file = agentPlistPath(userHome);
  mkdir(path.dirname(file), { recursive: true });
  write(file, plistFor({ corePath, logPath: path.join(home, 'launchd.log') }));
  const domain = `gui/${uid}`;
  // Replace any previous registration so a changed core path or interval takes effect.
  try { launchctl(run, ['bootout', `${domain}/${AGENT_LABEL}`]); } catch { /* not loaded yet */ }
  try { launchctl(run, ['bootstrap', domain, file]); }
  catch { launchctl(run, ['load', '-w', file]); } // older macOS, or no GUI domain yet
  let verified = { loaded: false, runsUpdate: false, interval: false };
  try { verified = describeAgent(launchctl(run, ['print', `${domain}/${AGENT_LABEL}`]), corePath); } catch { /* print missing on old macOS */ }
  return { label: AGENT_LABEL, file, ...verified };
}

export function unregisterLaunchAgent({ userHome = os.homedir(), uid = process.getuid?.(), run = execFileSync, remove = rmSync, exists = existsSync } = {}) {
  const file = agentPlistPath(userHome);
  let removed = false;
  try { launchctl(run, ['bootout', `gui/${uid}/${AGENT_LABEL}`]); removed = true; } catch { /* not loaded */ }
  if (exists(file)) { remove(file, { force: true }); removed = true; }
  return removed;
}

/** Read-only status for --status-file: is the agent loaded, and what does launchd say about its last run. */
export function agentStatus({ uid = process.getuid?.(), run = execFileSync, corePath = '' } = {}) {
  try {
    const text = launchctl(run, ['print', `gui/${uid}/${AGENT_LABEL}`]);
    const pick = key => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))?.[1]?.trim() ?? null;
    const verified = corePath ? describeAgent(text, corePath) : {};
    return { label: AGENT_LABEL, loaded: true, ...verified, state: pick('state'), runs: pick('runs'), lastExitCode: pick('last exit code'), runInterval: pick('run interval') };
  } catch { return { label: AGENT_LABEL, loaded: false }; }
}
