import {createPublicKey} from 'node:crypto';
export function pinnedPublicKey(pem,{allowEmpty=false}={}){
  if(!pem&&allowEmpty)return '';
  if(typeof pem!=='string'||!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----')||pem.includes('PRIVATE'))throw Error('public_trust_key_required');
  const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw Error('ed25519_public_key_required');
  return key.export({type:'spki',format:'pem'});
}
export function buildPublicTrust(env=process.env){
  const allowEmpty=env.SCB_ALLOW_UNTRUSTED_TEST_BUILD==='1';
  return {release_public_key:pinnedPublicKey(env.SCB_RELEASE_PUBLIC_KEY,{allowEmpty}),action_public_key:pinnedPublicKey(env.SCB_ACTION_PUBLIC_KEY,{allowEmpty})};
}
