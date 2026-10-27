// Device keys. Each phone makes an ECDSA P-256 key pair in the browser with a
// non-extractable private key, kept in IndexedDB. The public key's RFC 7638
// thumbprint is the device id. Every enrol and check-in request is signed.

import crypto from 'node:crypto';

export function thumbprint(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export function verify(jwk, message, signatureB64) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    // WebCrypto produces raw r||s signatures, not DER.
    return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64, 'base64url'));
  } catch {
    return false;
  }
}

export const enrolMessage = (courseCode, roll, nonce) => `earshot-enrol\n${courseCode.toUpperCase()}\n${roll}\n${nonce}`;
export const checkinMessage = (sessionId, roll, payload, nonce) => `earshot-checkin\n${sessionId}\n${roll}\n${payload}\n${nonce}`;
