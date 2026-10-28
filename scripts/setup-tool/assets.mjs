// The window's files. In the packaged EXE they are baked in (esbuild --define __SCB_ASSETS__); in development they are read from ./ui.
import { readFileSync } from 'node:fs';

const NAMES = ['ui.html', 'style.css', 'ui.js', 'logo.png'];
export function loadAssets(baked = typeof __SCB_ASSETS__ === 'string' ? __SCB_ASSETS__ : null) {
  if (baked) return JSON.parse(baked);
  return Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`./ui/${name}`, import.meta.url))
    .toString(name === 'logo.png' ? 'base64' : 'utf8')]));
}
export const ASSET_NAMES = NAMES;
