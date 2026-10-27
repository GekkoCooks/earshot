// This phone's identity: an ECDSA P-256 key pair whose private half cannot be
// exported from the browser. Stored in IndexedDB so it survives reloads.

const DB = 'earshot';
const STORE = 'keys';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function thumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

let cached;

export async function getIdentity() {
  if (cached) return cached;
  let record;
  let persistent = true;
  try {
    const db = await idb();
    record = await tx(db, 'readonly', (s) => s.get('device'));
    if (!record) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      record = { privateKey: pair.privateKey, publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
      await tx(db, 'readwrite', (s) => s.put(record, 'device'));
    }
  } catch {
    // Some private browsing modes block IndexedDB. Work for this visit only.
    persistent = false;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    record = { privateKey: pair.privateKey, publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  }
  const id = await thumbprint(record.publicKey);
  cached = {
    id,
    persistent,
    publicKey: record.publicKey,
    async sign(message) {
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, new TextEncoder().encode(message));
      return b64url(sig);
    },
  };
  return cached;
}

export const nonce = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
