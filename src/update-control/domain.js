import { verify, createPublicKey } from 'node:crypto';

export class ControlError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const fail = (condition, code, status = 400) => { if (!condition) throw new ControlError(code, status); };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HASH = /^[a-f0-9]{64}$/;
export const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const ACTIONS = new Set(['CHECK_STATUS', 'RETRY_UPDATE', 'REPAIR_SCHEDULER', 'VERIFY_RUNTIME']);
export const STATES = new Set(['CURRENT','OUTDATED','UPDATE_QUEUED','DOWNLOADING','VERIFYING_PACKAGE','INSTALLING',
  'AWAITING_RUNTIME_RELOAD','VERIFYING_RUNTIME','UPDATED','RETRY_SCHEDULED','USER_ACTION_REQUIRED','FAILED','OFFLINE','UNKNOWN']);
export const ERRORS = new Set(['UPDATER_NOT_REGISTERED','EXTENSION_NOT_RELOADED','DOWNLOAD_FAILED','HASH_MISMATCH',
  'CHROME_PERMISSION_REQUIRED','MAC_LAUNCHAGENT_FAILED','ANDROID_INSTALL_APPROVAL_REQUIRED','ANDROID_SIGNING_MISMATCH',
  'ANDROID_STORAGE_FAILED','ANDROID_INSTALL_CANCELLED','WORKER_API_INCOMPATIBLE','UPDATE_NOTIFICATION_LOOP',
  'RELEASE_ARTIFACT_MISMATCH','UPDATER_BUSY','INSTALL_FAILED','UNSUPPORTED_ACTION','RUNTIME_IDENTITY_MISSING','MONITOR_AUTH_REQUIRED']);
const fields = new Set(['source','sequence','running_version','installed_version','downloaded_version','updater_version',
  'release_id','artifact_hash','content_hash','build_sha','updater_health','update_state','last_error_code','os_version',
  'architecture','extension_id','chrome_profile_id','operation_id','action_result','version_code','notification_count','attempt_count']);
/** @typedef {{source:'runtime'|'updater',sequence:number,running_version?:string,installed_version?:string,build_sha?:string,content_hash?:string}} DeviceReport */
/** @param {DeviceReport} input */
export function validateReport(input) {
  fail(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_REPORT');
  for (const key of Object.keys(input)) fail(fields.has(key), 'UNSUPPORTED_REPORT_FIELD');
  fail(['runtime','updater'].includes(input.source), 'INVALID_SOURCE');
  fail(Number.isSafeInteger(input.sequence) && input.sequence > 0, 'INVALID_SEQUENCE');
  for (const [key, value] of Object.entries(input)) {
    const numeric=['sequence','version_code','notification_count','attempt_count'].includes(key);
    fail(numeric ? Number.isSafeInteger(value)&&value>=0&&(key==='sequence'||value<=2147483647) : typeof value==='string'&&value.length<=160, 'INVALID_FIELD');
    if (key.endsWith('_hash') && value) fail(HASH.test(value), 'INVALID_HASH');
  }
  for(const key of ['running_version','installed_version','downloaded_version','updater_version'])if(input[key])fail(/^\d+(\.\d+){1,3}$/.test(input[key]),'INVALID_VERSION');
  if (input.build_sha) fail(SHA.test(input.build_sha), 'INVALID_SHA');
  if (input.operation_id) fail(UUID.test(input.operation_id), 'INVALID_OPERATION');
  if (input.last_error_code) fail(ERRORS.has(input.last_error_code), 'INVALID_ERROR');
  if (input.update_state) fail(STATES.has(input.update_state), 'INVALID_STATE');
  if (input.updater_health) fail(['HEALTHY','MISSING','FAILED','UNKNOWN'].includes(input.updater_health), 'INVALID_HEALTH');
  fail(input.source !== 'updater' || !('running_version' in input), 'UPDATER_CANNOT_REPORT_RUNTIME');
  fail(input.source !== 'runtime' || !('updater_health' in input) && !('updater_version' in input), 'RUNTIME_CANNOT_REPORT_UPDATER_HEALTH');
  if (input.action_result) fail(['RECEIVED','STARTED','COMPLETED','FAILED'].includes(input.action_result) && input.operation_id, 'INVALID_ACTION_RESULT');
  return input;
}

export function retryPlan(code, attempts, jitter = Math.random) {
  const permanent = new Set(['RELEASE_ARTIFACT_MISMATCH','ANDROID_SIGNING_MISMATCH',
    'CHROME_PERMISSION_REQUIRED','ANDROID_INSTALL_APPROVAL_REQUIRED','ANDROID_INSTALL_CANCELLED','ANDROID_STORAGE_FAILED','MONITOR_AUTH_REQUIRED','UNSUPPORTED_ACTION']);
  if (permanent.has(code)) return { state: 'USER_ACTION_REQUIRED', delay_ms: null };
  if (code==='HASH_MISMATCH'&&attempts>=2) return {state:'USER_ACTION_REQUIRED',delay_ms:null};
  if (attempts >= 5) return { state: 'FAILED', delay_ms: null };
  return { state: 'RETRY_SCHEDULED', delay_ms: Math.round(Math.min(3600000, 60000 * 2 ** attempts) * (1 + jitter() * .25)) };
}

export function deriveState(report, target) {
  if (!target) return { state: 'UNKNOWN', error: null };
  if (report.last_error_code) return { state: 'FAILED', error: report.last_error_code };
  if (report.source === 'updater') {
    if(report.artifact_hash&&report.artifact_hash!==target.artifact_hash)return {state:'FAILED',error:'HASH_MISMATCH'};
    return { state: report.installed_version === target.version ? 'AWAITING_RUNTIME_RELOAD' : 'OUTDATED', error: null };
  }
  if (target.component_type==='android' && report.version_code!==target.version_code) return {state:'OUTDATED',error:null};
  if (report.running_version && report.running_version !== target.version) return { state: 'OUTDATED', error: null };
  if (!report.running_version || !report.build_sha || !report.content_hash) return { state: 'UNKNOWN', error: 'RUNTIME_IDENTITY_MISSING' };
  if (report.build_sha !== target.build_sha || report.content_hash !== target.content_hash) return { state: 'FAILED', error: 'RELEASE_ARTIFACT_MISMATCH' };
  return { state: 'UPDATED', error: null };
}

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function verifyEnvelope(envelope, publicKey, purpose) {
  fail(envelope?.payload?.purpose === purpose && typeof envelope.signature === 'string' && envelope.signature.length < 200, 'INVALID_ENVELOPE');
  let ok = false;
  try {
    const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
    ok = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(envelope.payload)), key, Buffer.from(envelope.signature, 'base64'));
  } catch { /* invalid signature is a denial */ }
  fail(ok, 'SIGNATURE_INVALID', 403);
  return envelope.payload;
}
