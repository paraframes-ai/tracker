import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectEol, fromLf, toLf } from '../src/eol.js';
import {
  fromBase64Url,
  generateRoomKey,
  importRoomKey,
  open,
  seal,
  toBase64Url,
} from '../src/crypto.js';
import { FRAME, decodeFrame, decodeSealed, encodeFrame, encodeSealed } from '../src/protocol.js';
import { EncryptedProvider } from '../src/provider.js';
import * as Y from 'yjs';
import { LIMITS, RateLimiter, Rooms } from '../src/server/rooms.js';
import { generateKeyPair, sign, verify } from '../src/server/jwt.js';

// -- line endings -----------------------------------------------------------

test('detectEol picks the dominant convention', () => {
  assert.equal(detectEol('a\r\nb\r\nc'), 'crlf');
  assert.equal(detectEol('a\nb\nc'), 'lf');
  assert.equal(detectEol('no newlines'), null);
  // Mixed file: majority wins rather than throwing.
  assert.equal(detectEol('a\r\nb\r\nc\nd'), 'crlf');
});

test('CRLF survives a disk -> CRDT -> disk round trip', () => {
  const original = 'struct A {\r\n  let x = 1\r\n}\r\n';
  const canonical = toLf(original);
  assert.equal(canonical, 'struct A {\n  let x = 1\n}\n');
  assert.equal(fromLf(canonical, 'crlf'), original);
});

test('fromLf does not double-convert existing CRLF', () => {
  // The regression that motivated the lookbehind: a naive \n -> \r\n replace on
  // text that already had CRLF produces \r\r\n.
  assert.equal(fromLf('a\r\nb', 'crlf'), 'a\r\nb');
  assert.ok(!fromLf('a\r\nb', 'crlf').includes('\r\r'));
});

test('two peers with different conventions agree on CRDT content', () => {
  const windows = 'line1\r\nline2\r\n';
  const mac = 'line1\nline2\n';
  // This equality is the whole point: without it every line differs and the
  // char-level merge rewrites the file on each save, in both directions.
  assert.equal(toLf(windows), toLf(mac));
});

// -- crypto -----------------------------------------------------------------

const ctx = { owner: 'ashwin', session: 'paraframes', sender: 'ashwin' };

test('seal/open round trip', async () => {
  const key = await importRoomKey(generateRoomKey());
  const msg = new TextEncoder().encode('hello crdt');
  const sealed = await seal(key, FRAME.CONTENT, ctx, msg);
  const opened = await open(key, FRAME.CONTENT, ctx, sealed);
  assert.deepEqual(new TextDecoder().decode(opened), 'hello crdt');
});

test('a different key cannot open the frame', async () => {
  const a = await importRoomKey(generateRoomKey());
  const b = await importRoomKey(generateRoomKey());
  const sealed = await seal(a, FRAME.CONTENT, ctx, new Uint8Array([1, 2, 3]));
  await assert.rejects(() => open(b, FRAME.CONTENT, ctx, sealed));
});

test('AAD binds the frame to room and sender', async () => {
  const key = await importRoomKey(generateRoomKey());
  const sealed = await seal(key, FRAME.CONTENT, ctx, new Uint8Array([9]));

  // Replayed into another room.
  await assert.rejects(() => open(key, FRAME.CONTENT, { ...ctx, session: 'other' }, sealed));
  // Reattributed to another peer.
  await assert.rejects(() => open(key, FRAME.CONTENT, { ...ctx, sender: 'william' }, sealed));
  // Relabelled as a different frame type.
  await assert.rejects(() => open(key, FRAME.AWARENESS, ctx, sealed));
});

test('tampered ciphertext is rejected', async () => {
  const key = await importRoomKey(generateRoomKey());
  const sealed = await seal(key, FRAME.CONTENT, ctx, new Uint8Array([1, 2, 3, 4]));
  sealed[sealed.length - 1] ^= 0xff;
  await assert.rejects(() => open(key, FRAME.CONTENT, ctx, sealed));
});

test('nonces differ across frames with the same plaintext', async () => {
  const key = await importRoomKey(generateRoomKey());
  const msg = new Uint8Array([7, 7, 7]);
  const a = await seal(key, FRAME.CONTENT, ctx, msg);
  const b = await seal(key, FRAME.CONTENT, ctx, msg);
  assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12));
});

test('room key base64url round trip, and length is enforced', () => {
  const key = generateRoomKey();
  assert.deepEqual(fromBase64Url(toBase64Url(key)), key);
  assert.throws(() => fromBase64Url(toBase64Url(new Uint8Array(16))), /32 bytes/);
});

// -- protocol ---------------------------------------------------------------

test('frame encode/decode round trip', () => {
  const { type, payload } = decodeFrame(encodeFrame(FRAME.AWARENESS, new Uint8Array([1, 2])));
  assert.equal(type, FRAME.AWARENESS);
  assert.deepEqual(payload, new Uint8Array([1, 2]));
});

test('sealed frame carries the sender in the clear', () => {
  const sealed = new Uint8Array([5, 6, 7]);
  const frame = decodeFrame(encodeSealed(FRAME.CONTENT, 'william', sealed));
  const decoded = decodeSealed(frame.payload);
  assert.equal(decoded.sender, 'william');
  assert.deepEqual(decoded.sealed, sealed);
});

test('truncated sealed frames are rejected, not misread', () => {
  assert.throws(() => decodeSealed(new Uint8Array([])), /truncated/);
  assert.throws(() => decodeSealed(new Uint8Array([40, 1, 2])), /truncated sender/);
});

// -- service tokens ---------------------------------------------------------

test('token sign/verify round trip', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const token = sign({ privateKey, sub: 'gh:1', username: 'ashwin', ttlSeconds: 60 });
  assert.equal(verify(token, publicKey).username, 'ashwin');
});

test('a token signed by another key is rejected', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const token = sign({ privateKey: a.privateKey, sub: 'gh:1', username: 'x', ttlSeconds: 60 });
  assert.throws(() => verify(token, b.publicKey), /bad signature/);
});

test('expired tokens are rejected', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const token = sign({ privateKey, sub: 'gh:1', username: 'x', ttlSeconds: -1 });
  assert.throws(() => verify(token, publicKey), /expired/);
});

test('a tampered payload is rejected', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const token = sign({ privateKey, sub: 'gh:1', username: 'ashwin', ttlSeconds: 60 });
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'gh:1', username: 'root', exp: 2 ** 40 }))
    .toString('base64url');
  assert.throws(() => verify(`${h}.${forged}.${s}`, publicKey), /bad signature/);
});

// -- provider: allowlist plumbing and key-mismatch blame --------------------

function makeProvider({ username, roomKey, owner = 'alice', session = 'demo', allow }) {
  // The constructor does not open a socket; connect() does. So this exercises
  // URL construction and frame handling without a relay.
  return new EncryptedProvider({
    relay: 'ws://127.0.0.1:1',
    owner,
    session,
    username,
    token: 'unused',
    roomKey,
    allow,
    doc: new Y.Doc(),
  });
}

test('allowlist reaches the relay on the connect URL', () => {
  // Regression: --allow was parsed by the CLI and passed to runSync but never
  // put in the URL, so the relay saw no allowlist and admitted everyone.
  const withAllow = makeProvider({ username: 'alice', roomKey: generateRoomKey(), allow: ['bob'] });
  assert.match(withAllow._url(), /\?allow=bob$/);
  withAllow.destroy();

  const without = makeProvider({ username: 'alice', roomKey: generateRoomKey() });
  assert.ok(!without._url().includes('allow='));
  without.destroy();
});

test('an undecryptable frame from an established peer is fatal (our key is wrong)', async () => {
  const mine = generateRoomKey();
  const p = makeProvider({ username: 'bob', roomKey: mine });
  p.key = await importRoomKey(mine);
  p.initialPeers = new Set(['alice']); // alice was already in the room when we joined

  const foreign = await importRoomKey(generateRoomKey());
  const sealed = await seal(
    foreign,
    FRAME.CONTENT,
    { owner: 'alice', session: 'demo', sender: 'alice' },
    new Uint8Array([1]),
  );

  let fatal = null;
  p.on('fatal', (e) => {
    fatal = e;
  });
  await p._onMessage(encodeSealed(FRAME.CONTENT, 'alice', sealed));
  assert.equal(fatal?.code, 'BAD_KEY');
  p.destroy();
});

test('an undecryptable frame from a later joiner is ignored, not fatal', async () => {
  // Regression: this used to be fatal, so any stranger who could reach a room
  // could end the owner's session just by connecting with a garbage key.
  const mine = generateRoomKey();
  const p = makeProvider({ username: 'alice', roomKey: mine });
  p.key = await importRoomKey(mine);
  p.initialPeers = new Set(); // we created the room; nobody was here

  const foreign = await importRoomKey(generateRoomKey());
  const sealed = await seal(
    foreign,
    FRAME.CONTENT,
    { owner: 'alice', session: 'demo', sender: 'carol' },
    new Uint8Array([1]),
  );

  let fatal = null;
  let ignored = null;
  p.on('fatal', (e) => {
    fatal = e;
  });
  p.on('peer-key-mismatch', (peer) => {
    ignored = peer;
  });
  await p._onMessage(encodeSealed(FRAME.CONTENT, 'carol', sealed));
  assert.equal(fatal, null);
  assert.equal(ignored, 'carol');
  assert.ok(p.badSenders.has('carol'));

  // ...and a rejoin clears the mark, or a peer who fixes their key stays
  // ignored forever.
  p._onControl({ type: 'peer-joined', peer: 'carol' });
  assert.ok(!p.badSenders.has('carol'));
  p.destroy();
});

// -- rooms and quotas -------------------------------------------------------

test('rooms track peers and clean up when empty', () => {
  const rooms = new Rooms({ ...LIMITS, idleRoomTtlMs: 5 });
  const room = rooms.create({ owner: 'ashwin', session: 'p' });
  const conn = { username: 'ashwin' };
  rooms.attach(room, conn);
  assert.equal(rooms.connectionsFor('ashwin'), 1);
  assert.equal(rooms.countRoomsOwnedBy('ashwin'), 1);
  rooms.detach(room, conn);
  assert.equal(rooms.connectionsFor('ashwin'), 0);
});

test('peerNames excludes the asking connection', () => {
  const rooms = new Rooms();
  const room = rooms.create({ owner: 'a', session: 's' });
  const c1 = { username: 'a' };
  const c2 = { username: 'b' };
  rooms.attach(room, c1);
  rooms.attach(room, c2);
  assert.deepEqual(rooms.peerNames(room, c1), ['b']);
});

test('rate limiter refuses oversized frames by name', () => {
  const rl = new RateLimiter({
    peersPerRoom: 8,
    maxFrameBytes: 100,
    framesPerSecond: 10,
    frameBurst: 2,
    bytesPerSecond: 1000,
    idleRoomTtlMs: 1000,
  });
  assert.equal(rl.check(50), null);
  assert.equal(rl.check(101), 'maxFrameBytes');
});

test('rate limiter exhausts its frame burst', () => {
  const rl = new RateLimiter({
    peersPerRoom: 8,
    maxFrameBytes: 1000,
    framesPerSecond: 0,
    frameBurst: 2,
    bytesPerSecond: 10_000,
    idleRoomTtlMs: 1000,
  });
  assert.equal(rl.check(1), null);
  assert.equal(rl.check(1), null);
  assert.equal(rl.check(1), 'framesPerSecond');
});
