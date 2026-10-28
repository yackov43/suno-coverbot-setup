import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyPackage(bytes, release, expectedKey) {
  if (!/^[a-f0-9]{64}$/.test(release.sha256 || '') || sha(bytes) !== release.sha256) throw new Error('checksum_mismatch');
  if (bytes.length > 16 * 1024 * 1024) throw new Error('package_too_large');
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('invalid_zip');
  const count = bytes.readUInt16LE(end + 10);
  if (!count || count > 200) throw new Error('invalid_zip');
  let offset = bytes.readUInt32LE(end + 16), total = 0, manifest;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('invalid_zip');
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const rawName = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const name = rawName.startsWith('./') ? rawName.slice(2) : rawName;
    if ((!name && rawName !== './') || /[\\\x00:]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') || names.has(name.toLowerCase())) throw new Error('invalid_zip_path');
    names.add(name.toLowerCase());
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), local = bytes.readUInt32LE(offset + 42);
    total += size;
    if (size > 8 * 1024 * 1024 || total > 64 * 1024 * 1024 || local + 30 > end) throw new Error('invalid_zip_size');
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(offset + 8) & 1) throw new Error('invalid_zip');
    const localLength = bytes.readUInt16LE(local + 26), start = local + 30 + localLength + bytes.readUInt16LE(local + 28);
    if (bytes.toString('utf8', local + 30, local + 30 + localLength) !== rawName || start + compressed > end) throw new Error('invalid_zip');
    const method = bytes.readUInt16LE(offset + 10), data = bytes.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error('invalid_zip_method');
    const plain = method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }) : data;
    if (plain.length !== size || (crc32(plain) >>> 0) !== bytes.readUInt32LE(offset + 16)) throw new Error('invalid_zip_integrity');
    if (name === 'manifest.json') manifest = JSON.parse(plain);
    offset += 46 + nameLength + extra + comment;
  }
  if (!manifest || manifest.key !== expectedKey || manifest.version !== release.version) throw new Error('package_identity_mismatch');
  return { version: manifest.version, sha256: release.sha256, files: count };
}

/** Owner-only developer pilot. No OS installation, profile or task operations. */
export class SetupPilot {
  #deviceId = randomUUID();
  #startedAt; #phase = 'ready'; #attempts = 0; #used = false; #busy = false; #ownerMask = '';
  constructor({ enabled = false, now = Date.now, remote, fetchPackage, persist, expectedKey }) {
    Object.assign(this, { enabled, now, remote, fetchPackage, persist, expectedKey });
    this.#startedAt = now();
  }
  status() { return { phase: this.#phase, busy: this.#busy, ownerMask: this.#ownerMask }; }
  #guard() {
    if (!this.enabled) throw new Error('pilot_disabled');
    this.#checkExpiry();
    if (this.#busy) throw new Error('busy');
  }
  #checkExpiry() {
    if (this.now() - this.#startedAt >= 10 * 60_000) { this.#phase = 'expired'; throw new Error('session_expired'); }
  }
  async #operation(operation) {
    this.#guard(); this.#busy = true;
    try { return await operation(); }
    catch (error) { if (this.#phase !== 'waiting') this.#phase = 'denied'; throw error; }
    finally { this.#busy = false; }
  }
  async begin() {
    return this.#operation(async () => {
      if (this.#phase !== 'ready') throw new Error('already_started');
      const value = await this.remote('begin', { deviceId: this.#deviceId });
      if (value?.ok !== true) throw new Error('authorization_denied');
      this.#ownerMask = value.ownerMask || '';
      this.#phase = 'waiting';
      return this.status();
    });
  }
  async verify(otp) {
    return this.#operation(async () => {
      if (this.#phase !== 'waiting' || !/^\d{6}$/.test(otp) || ++this.#attempts > 5) throw new Error('authorization_denied');
      const value = await this.remote('verify', { deviceId: this.#deviceId, otp });
      if (value?.ok !== true) throw new Error('authorization_denied');
      this.#phase = 'verified'; return this.status();
    });
  }
  async download() {
    return this.#operation(async () => {
      if (this.#phase !== 'verified' || this.#used) throw new Error('not_verified_or_already_used');
      this.#used = true;
      this.#phase = 'checking';
      const auth = await this.remote('check', { deviceId: this.#deviceId });
      if (auth?.ok !== true) throw new Error('authorization_denied');
      const release = auth.release;
      if (!/^\/scb-extension-[a-f0-9]{16}\.zip$/.test(release?.url || '') || !/^\d+(\.\d+){1,3}$/.test(release.version || '')) throw new Error('invalid_release');
      this.#phase = 'downloading';
      const bytes = await this.fetchPackage(release.url);
      const checked = verifyPackage(bytes, release, this.expectedKey);
      this.#phase = 'checking';
      if ((await this.remote('check', { deviceId: this.#deviceId }))?.ok !== true) throw new Error('authorization_denied');
      this.#checkExpiry();
      const file = await this.persist(bytes, checked);
      this.#phase = 'complete';
      return { ...checked, file, installed: false, schedulerRegistered: false };
    });
  }
}
