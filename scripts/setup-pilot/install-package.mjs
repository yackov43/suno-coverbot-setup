// Writes an already-verifiable extension ZIP into the extension folder. Shared by the first install and the quiet updater.
// No PowerShell, no shell: plain Node. Everything is checked (core.verifyPackage) BEFORE a single file is written.
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { verifyPackage } from './core.mjs';

/** Entries of a ZIP that verifyPackage has already accepted (names, sizes and CRCs are validated there). */
export function zipEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const rawName = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const name = rawName.startsWith('./') ? rawName.slice(2) : rawName;
    const compressed = bytes.readUInt32LE(offset + 20), local = bytes.readUInt32LE(offset + 42), method = bytes.readUInt16LE(offset + 10);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + compressed);
    if (name && !name.endsWith('/')) entries.push({ name, data: method === 8 ? inflateRawSync(data) : Buffer.from(data) });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

function writeAtomic(file, data) {
  assertNoLinks(file);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, data, { flag: 'wx' });
  renameSync(temporary, file);
}

/** Includes existing parent junctions on Windows; never follow a package destination link. */
export function assertNoLinks(file) {
  let current=path.resolve(file);
  for(;;){
    try{if(lstatSync(current).isSymbolicLink())throw new Error('unsafe_output_link');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}

/**
 * @param {Buffer} bytes ZIP bytes
 * @param {{sha256:string, version:string}} release expected release identity
 * @param {{key:string, directory:string, previousVersion?:string}} target trusted extension key + destination folder
 * Dependencies first, the service-worker entry next, manifest.json LAST: the running extension reloads when it sees a
 * newer manifest, and by then every other file must already be the new one.
 */
export function installPackage(bytes, release, { key, directory, previousVersion = null, registered = true }) {
  if (!path.isAbsolute(directory)) throw new Error('invalid_directory');
  const checked = verifyPackage(bytes, release, key);
  const root = path.resolve(directory) + path.sep;
  const files = zipEntries(bytes).map(entry => ({ ...entry, target: path.resolve(directory, ...entry.name.split('/')) }));
  for (const file of files) {if (!file.target.startsWith(root)) throw new Error('unsafe_output_path');assertNoLinks(file.target);}
  const rank = file => (file.name === 'manifest.json' ? 2 : file.name === 'background.js' ? 1 : 0);
  // Touch only what differs. Rewriting identical files (the manifest above all) made Chrome drop the loaded extension, so an
  // up-to-date folder must stay byte-for-byte and timestamp-for-timestamp untouched.
  let changed = 0;
  for (const file of [...files].sort((a, b) => rank(a) - rank(b))) {
    let same = false;
    try { same = existsSync(file.target) && readFileSync(file.target).equals(file.data); } catch { same = false; }
    if (!same) { writeAtomic(file.target, file.data); changed++; }
  }
  writeMarker(directory, { registered, previousVersion, targetVersion: checked.version });
  return { ...checked, previousVersion, changed };
}

/** `registered` tells the extension that a native updater exists; set it true only once that is VERIFIED. No BOM: it is JSON.parse()d. */
export function writeMarker(directory, { registered, previousVersion = null, targetVersion }) {
  const file = path.join(directory, 'scb-native-updater.json');
  let identity = {};
  try {
    const current = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    for (const key of ['installation_id','public_key','architecture','authority']) if (current[key]) identity[key] = current[key];
    if (current.registered === registered && current.previousVersion === previousVersion && current.targetVersion === targetVersion && current.mode === 'scheduled') return; // unchanged: do not touch the folder
  } catch { /* no marker yet */ }
  writeAtomic(path.join(directory, 'scb-native-updater.json'), JSON.stringify({
    ...identity, registered, mode: 'scheduled', previousVersion, targetVersion, filesWrittenAt: new Date().toISOString(),
  }));
}

export function installedVersion(directory) {
  const file = path.join(directory, 'manifest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')).version : null;
}

export function removeQuietly(file) { rmSync(file, { force: true }); }
