// Service tokens (RFC 001 §5.3): Ed25519-signed JWTs.
//
// node:crypto only — no dependency, and it works identically under Bun, which
// keeps the single-binary build viable.

import crypto from 'node:crypto';

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

export function loadOrCreateKeyPair(pem) {
  if (!pem) return generateKeyPair();
  const privateKey = crypto.createPrivateKey(pem);
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

export function sign({ privateKey, sub, username, ttlSeconds }) {
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, username, iat: now, exp: now + ttlSeconds };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = crypto.sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

// Returns the payload, or throws. Callers treat any throw as "unauthenticated"
// and must not leak the reason to the client beyond that.
export function verify(token, publicKey) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), publicKey, unb64u(s));
  if (!ok) throw new Error('bad signature');
  const payload = JSON.parse(unb64u(p).toString('utf8'));
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('expired');
  }
  if (!payload.username) throw new Error('no username');
  return payload;
}
