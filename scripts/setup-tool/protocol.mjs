// Registers scbsetup:// (and legacy scbhelper://) for the CURRENT Windows user (HKCU, no admin),
// so the website and the extension can open the already-installed setup tool. The handler ignores
// everything after the scheme except the path word (run|install|update); no data rides in the link.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SCHEMES = ['scbsetup', 'scbhelper'];
const reg = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

export function protocolCommands(exePath, scheme = 'scbsetup') {
  const KEY = `HKCU\\Software\\Classes\\${scheme}`;
  return [
    ['add', KEY, '/ve', '/d', 'URL:Suno CoverBot Setup', '/f'],
    ['add', KEY, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${KEY}\\DefaultIcon`, '/ve', '/d', `"${exePath}",0`, '/f'],
    ['add', `${KEY}\\shell\\open\\command`, '/ve', '/d', `"${exePath}" --launch "%1"`, '/f'],
  ];
}
export function registerProtocol(exePath, run = execFileSync) {
  if (process.platform !== 'win32') return; // macOS registers via the .app Info.plist at build time
  for (const scheme of SCHEMES) {
    for (const args of protocolCommands(exePath, scheme)) run(reg(), args, { windowsHide: true, stdio: 'ignore' });
  }
}
export function unregisterProtocol(run = execFileSync) {
  if (process.platform !== 'win32') return false;
  let any = false;
  for (const scheme of SCHEMES) {
    try {
      run(reg(), ['delete', `HKCU\\Software\\Classes\\${scheme}`, '/f'], { windowsHide: true, stdio: 'ignore' });
      any = true;
    } catch { /* missing */ }
  }
  return any;
}
