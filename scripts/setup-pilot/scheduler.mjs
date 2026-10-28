import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const WSCRIPT = path.join(SYSTEM32, 'wscript.exe');
export const UPDATE_INTERVAL = 'PT15M';

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const taskNameFor = sid => `SunoCoverBot-Setup-Updater-${sid}`;

/** wscript is GUI-subsystem and Run(...,0) hides the child, so the Node updater never opens a console window. */
export function launcherScript(nodePath, updaterPath) {
  const command = `"${nodePath}" "${updaterPath}"`;
  return `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${command.replace(/"/g, '""')}", 0, True\r\n`;
}

export function taskXml({ sid, launcherPath, startAt }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger><TimeTrigger><Repetition><Interval>${UPDATE_INTERVAL}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${startAt}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><Hidden>true</Hidden><ExecutionTimeLimit>PT5M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xml(WSCRIPT)}</Command><Arguments>${xml(`//B //Nologo "${launcherPath}"`)}</Arguments></Exec></Actions>
</Task>
`;
}

/**
 * What a registered task must look like; used both after registering and by the tests. Windows normalizes the XML it
 * hands back (C:\WINDOWS casing, the default RunLevel is omitted, the logon UserId becomes DOMAIN\user), so compare
 * case-insensitively and treat "no elevated RunLevel" as least privilege.
 */
export function describeTask(xmlText, sid, launcherPath) {
  // Windows returns element text with plain quotes; decode entities so we compare real text, not our own escaping.
  const decoded = xmlText.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const lower = decoded.toLowerCase();
  const has = text => lower.includes(text.toLowerCase());
  const enabled=tag=>{const section=new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','i').exec(decoded)?.[1];return section!==undefined&&!/<Enabled>\s*false\s*<\/Enabled>/i.test(section);};
  return {
    enabled: enabled('Settings'),
    triggersEnabled: enabled('TimeTrigger') && enabled('LogonTrigger'),
    quietHost: has(`<Command>${WSCRIPT}</Command>`) && has(`//B //Nologo "${launcherPath}"`),
    noPowershell: !/powershell|pwsh/i.test(decoded),
    hidden: has('<Hidden>true</Hidden>'),
    interval: has(`<Interval>${UPDATE_INTERVAL}</Interval>`),
    logon: has('<LogonTrigger>') && has(`<UserId>${sid}</UserId>`),
    leastPrivilege: !has('<RunLevel>HighestAvailable</RunLevel>'),
  };
}

const schtasks = (...args) => execFileSync(path.join(SYSTEM32, 'schtasks.exe'), args, { encoding: 'utf8', windowsHide: true });

export function currentSid() {
  // Absolute System32 path: under Git Bash a bare `whoami` is GNU coreutils and rejects /user.
  // `whoami /user /fo csv /nh` -> "HOST\user","S-1-5-21-..."
  const out = execFileSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = out.match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error('sid_not_found');
  return sid;
}

export function registerUpdater({ directory, launcherPath, sid = currentSid(), now = new Date() }) {
  const startAt = new Date(now.getTime() + 60_000).toISOString().slice(0, 19);
  const file = path.join(directory, 'scb-updater-task.xml');
  // schtasks reads UTF-16 with a BOM.
  writeFileSync(file, '\ufeff' + taskXml({ sid, launcherPath, startAt }), 'utf16le');
  schtasks('/Create', '/TN', taskNameFor(sid), '/XML', file, '/F');
  const verified = describeTask(schtasks('/Query', '/TN', taskNameFor(sid), '/XML'), sid, launcherPath);
  const failed = Object.entries(verified).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) throw new Error('registered_task_mismatch:' + failed.join(','));
  return { taskName: taskNameFor(sid), ...verified };
}

export function unregisterUpdater(sid = currentSid()) {
  try { schtasks('/Delete', '/TN', taskNameFor(sid), '/F'); return true; } catch { return false; }
}
