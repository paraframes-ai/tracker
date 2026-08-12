// Wire protocol (RFC 001 §7).
//
// Every frame is [1 byte type][payload]. The relay reads only the type byte and,
// for content frames, the plaintext sender prefix. It never parses ciphertext.
//
// CONTENT / AWARENESS payload:
//     [senderLen: 1][sender: utf8][nonce(12) ‖ ciphertext ‖ tag(16)]
//
// The sender is plaintext because §8's AAD binds each frame to its sender: the
// receiver must know who sent a frame in order to verify it. Carrying it in the
// clear also lets the relay reject a peer claiming to be someone else (a cheap
// check requiring no key), and because it is covered by the AAD, a relay that
// lies about the sender causes decryption to fail rather than misattribution.
//
// CONTROL and PING are plaintext by design — presence has to name peers, and
// errors must stay legible when decryption is the thing that is broken.

export const FRAME = {
  CONTENT: 0x01, // encrypted Yjs sync/update
  AWARENESS: 0x02, // encrypted awareness/presence
  CONTROL: 0x03, // relay -> peer: hello, peer-joined, peer-left, error
  PING: 0x04, // keepalive, either direction
};

export const PROTOCOL_VERSION = 1;

// 4000-4999 is the application-defined range for WebSocket close codes.
export const CLOSE = {
  UNAUTHENTICATED: 4001,
  FORBIDDEN: 4003,
  ROOM_NOT_FOUND: 4004,
  QUOTA: 4029,
  BAD_FRAME: 4400,
  SERVER_SHUTDOWN: 4500,
};

export const isEncrypted = (type) => type === FRAME.CONTENT || type === FRAME.AWARENESS;

export function encodeFrame(type, payload) {
  const out = new Uint8Array(1 + (payload ? payload.length : 0));
  out[0] = type;
  if (payload) out.set(payload, 1);
  return out;
}

export function decodeFrame(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 1) throw new Error('empty frame');
  return { type: bytes[0], payload: bytes.subarray(1) };
}

export function encodeSealed(type, sender, sealed) {
  const name = new TextEncoder().encode(sender);
  if (name.length > 255) throw new Error('sender name too long');
  const payload = new Uint8Array(1 + name.length + sealed.length);
  payload[0] = name.length;
  payload.set(name, 1);
  payload.set(sealed, 1 + name.length);
  return encodeFrame(type, payload);
}

export function decodeSealed(payload) {
  if (payload.length < 1) throw new Error('truncated frame');
  const nameLen = payload[0];
  if (payload.length < 1 + nameLen) throw new Error('truncated sender');
  return {
    sender: new TextDecoder().decode(payload.subarray(1, 1 + nameLen)),
    sealed: payload.subarray(1 + nameLen),
  };
}

export const encodeControl = (obj) =>
  encodeFrame(FRAME.CONTROL, new TextEncoder().encode(JSON.stringify(obj)));

export const decodeControl = (payload) => JSON.parse(new TextDecoder().decode(payload));
