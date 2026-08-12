// Hosted relay (RFC 001 §4, §9).
//
// This replaces the y-websocket-based relay. It is strictly simpler: it holds no
// Yjs document, runs no CRDT logic, and cannot — every content frame is
// ciphertext. Its whole job is to authenticate a connection, route by room id,
// enforce quotas, and fan out bytes.
//
// Endpoints:
//   GET  /                       health text
//   POST /v1/auth/exchange       { githubToken } -> { token, username }
//   POST /v1/auth/dev            { username }    -> { token, username }   (dev only)
//   WS   /v1/rooms/:owner/:session
//
// Env:
//   PORT, HOST
//   TRACKER_JWT_PRIVATE_KEY   Ed25519 private key PEM (ephemeral if unset)
//   TRACKER_DEV_AUTH=1        enable /v1/auth/dev — never set in production
//   TRACKER_TOKEN_TTL_DAYS    default 30

import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import {
  CLOSE,
  FRAME,
  decodeFrame,
  decodeSealed,
  encodeControl,
  isEncrypted,
} from '../protocol.js';
import { LIMITS, RateLimiter, Rooms } from './rooms.js';
import { loadOrCreateKeyPair, sign, verify } from './jwt.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DEV_AUTH = process.env.TRACKER_DEV_AUTH === '1';
const TTL_DAYS = Number(process.env.TRACKER_TOKEN_TTL_DAYS || 30);

// A PEM is multi-line, which makes it awkward to carry in a systemd
// EnvironmentFile — so accept a path as well as the key material itself.
function signingKeyPem() {
  const file = process.env.TRACKER_JWT_PRIVATE_KEY_FILE;
  if (file) return fs.readFileSync(file, 'utf8');
  return process.env.TRACKER_JWT_PRIVATE_KEY;
}

// Same public client id the CLI compiles in (device flow has no secret).
const GITHUB_CLIENT_ID = process.env.TRACKER_GITHUB_CLIENT_ID || 'Ov23liRkXOV0SuKwsR5M';

const SERVER_STARTED_AT = Date.now();
// Recent refusals, capped — enough to answer "why is this not syncing" without
// becoming an unbounded log in memory.
const refusals = [];

const keys = loadOrCreateKeyPair(signingKeyPem());
const ephemeralKey = !process.env.TRACKER_JWT_PRIVATE_KEY_FILE && !process.env.TRACKER_JWT_PRIVATE_KEY;
const rooms = new Rooms();

const log = (msg) => console.log(`[relay] ${msg}`);

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });

const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

// Resolve a GitHub token to a login. We request no scopes at login time, so this
// token can read nothing else; we use it once and never store it.
async function githubIdentity(githubToken) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tracker-relay',
    },
  });
  if (!res.ok) throw new Error(`github rejected the token (${res.status})`);
  const user = await res.json();
  if (!user?.login || !user?.id) throw new Error('github returned no login');
  return { sub: `gh:${user.id}`, username: String(user.login).toLowerCase() };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('tracker relay ok\n');
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/auth/exchange') {
    try {
      const { githubToken } = await readJson(req);
      if (!githubToken) return sendJson(res, 400, { error: 'githubToken required' });
      const ident = await githubIdentity(githubToken);
      const token = sign({ ...ident, privateKey: keys.privateKey, ttlSeconds: TTL_DAYS * 86400 });
      log(`issued token for ${ident.username}`);
      return sendJson(res, 200, { token, username: ident.username, expiresInDays: TTL_DAYS });
    } catch (err) {
      return sendJson(res, 401, { error: err.message });
    }
  }

  // Dev-only shortcut so the transport and crypto can be tested without
  // registering a GitHub OAuth app. Refuses unless explicitly enabled.
  if (req.method === 'POST' && req.url === '/v1/auth/dev') {
    if (!DEV_AUTH) return sendJson(res, 404, { error: 'not found' });
    try {
      const { username } = await readJson(req);
      if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(username || '')) {
        return sendJson(res, 400, { error: 'invalid username' });
      }
      const token = sign({
        sub: `dev:${username}`,
        username,
        privateKey: keys.privateKey,
        ttlSeconds: TTL_DAYS * 86400,
      });
      return sendJson(res, 200, { token, username, expiresInDays: TTL_DAYS });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- dashboard -----------------------------------------------------------

  if (req.method === 'GET' && (req.url === '/dashboard' || req.url === '/dashboard/')) {
    let html;
    try {
      html = fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
    } catch {
      return sendJson(res, 500, { error: 'dashboard asset missing' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // The dashboard is same-origin and self-contained; no external anything.
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(html);
  }

  // GitHub's device endpoints send no CORS headers, so a browser cannot call
  // them directly. The relay proxies the two steps. No client secret is
  // involved — device flow does not use one.
  if (req.method === 'POST' && req.url === '/v1/auth/device/start') {
    try {
      const r = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: '' }),
      });
      const j = await r.json();
      if (j.error) return sendJson(res, 400, { error: j.error_description || j.error });
      return sendJson(res, 200, {
        device_code: j.device_code,
        user_code: j.user_code,
        verification_uri: j.verification_uri,
        interval: j.interval || 5,
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/v1/auth/device/poll') {
    try {
      const { device_code } = await readJson(req);
      if (!device_code) return sendJson(res, 400, { error: 'device_code required' });
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const j = await r.json();
      if (j.access_token) {
        const ident = await githubIdentity(j.access_token);
        const token = sign({ ...ident, privateKey: keys.privateKey, ttlSeconds: TTL_DAYS * 86400 });
        log(`issued token for ${ident.username} (browser)`);
        return sendJson(res, 200, { token, username: ident.username });
      }
      if (j.error === 'authorization_pending' || j.error === 'slow_down') {
        return sendJson(res, 202, { pending: true, error: j.error });
      }
      return sendJson(res, 400, { error: j.error_description || j.error || 'device flow failed' });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // Live session metadata, scoped to what the caller is actually part of.
  if (req.method === 'GET' && req.url.startsWith('/v1/sessions')) {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    let claims;
    try {
      claims = verify(bearer, keys.publicKey);
    } catch {
      return sendJson(res, 401, { error: 'unauthenticated' });
    }
    const username = String(claims.username).toLowerCase();
    return sendJson(res, 200, {
      you: username,
      now: Date.now(),
      startedAt: SERVER_STARTED_AT,
      limits: { peersPerRoom: LIMITS.peersPerRoom, maxFrameBytes: LIMITS.maxFrameBytes },
      refusals: refusals.slice(-25),
      sessions: rooms.snapshot(username),
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

const wss = new WebSocketServer({ noServer: true });

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function parseRoomPath(url) {
  const m = /^\/v1\/rooms\/([^/?]+)\/([^/?]+)/.exec(url);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]).toLowerCase();
  const session = decodeURIComponent(m[2]).toLowerCase();
  if (!NAME_RE.test(owner) || !NAME_RE.test(session)) return null;
  return { owner, session };
}

server.on('upgrade', (req, socket, head) => {
  const reject = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const target = parseRoomPath(req.url || '');
  if (!target) return reject(400, 'Bad Request');

  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!bearer) return reject(401, 'Unauthorized');

  let claims;
  try {
    claims = verify(bearer, keys.publicKey);
  } catch {
    return reject(401, 'Unauthorized');
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    onConnection(ws, claims, target, req);
  });
});

function onConnection(ws, claims, { owner, session }, req) {
  const username = String(claims.username).toLowerCase();
  const now = Date.now();
  const conn = {
    ws,
    username,
    limiter: new RateLimiter(),
    joinedAt: now,
    lastActiveAt: now,
    bytesIn: 0,
    bytesOut: 0,
    frames: 0,
  };

  const fail = (code, reason) => {
    // Log every refusal. Without this a peer can be rejected hundreds of times
    // while the relay log shows nothing but healthy-looking joins and leaves,
    // which is exactly how a quota misconfiguration hid as "it just doesn't
    // sync".
    log(`refused ${username} on ${owner}/${session}: ${code} ${reason}`);
    refusals.push({ at: Date.now(), username, room: `${owner}/${session}`, code, reason });
    if (refusals.length > 100) refusals.shift();
    try {
      ws.send(encodeControl({ type: 'error', code, reason }));
    } catch {
      /* closing anyway */
    }
    ws.close(code, reason);
  };

  if (rooms.connectionsFor(username) >= LIMITS.connectionsPerUser) {
    return fail(CLOSE.QUOTA, 'connectionsPerUser');
  }

  const isOwner = username === owner;
  let room = rooms.get(owner, session);

  if (!room) {
    // Creating a room under a namespace requires being that namespace's owner.
    if (!isOwner) return fail(CLOSE.ROOM_NOT_FOUND, 'no such session');
    if (rooms.countRoomsOwnedBy(username) >= LIMITS.roomsPerUser) {
      return fail(CLOSE.QUOTA, 'roomsPerUser');
    }
    const allowParam = new URL(req.url, 'http://localhost').searchParams.get('allow');
    room = rooms.create({
      owner,
      session,
      allow: allowParam ? allowParam.split(',').filter(Boolean) : null,
    });
    log(`room created ${owner}/${session}`);
  }

  // Usernames are authenticated, so an allowlist is enforceable here. Key
  // possession is not checkable by the relay — that is the point of §8.
  if (!isOwner && room.allow && !room.allow.has(username)) {
    return fail(CLOSE.FORBIDDEN, 'not in this session allowlist');
  }
  if (room.conns.size >= LIMITS.peersPerRoom) {
    return fail(CLOSE.QUOTA, 'peersPerRoom');
  }

  const peers = rooms.peerNames(room, conn);
  rooms.attach(room, conn);

  ws.send(encodeControl({ type: 'hello', you: username, peers, room: `${owner}/${session}` }));
  broadcastControl(room, conn, { type: 'peer-joined', peer: username });
  log(`${username} joined ${owner}/${session} (${room.conns.size} peer(s))`);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return fail(CLOSE.BAD_FRAME, 'binary frames only');

    const limitHit = conn.limiter.check(data.length);
    if (limitHit) return fail(CLOSE.QUOTA, limitHit);

    let frame;
    try {
      frame = decodeFrame(data);
    } catch {
      return fail(CLOSE.BAD_FRAME, 'undecodable frame');
    }

    if (frame.type === FRAME.PING) return;

    if (!isEncrypted(frame.type)) {
      // Peers do not send control frames; only the relay does.
      return fail(CLOSE.BAD_FRAME, 'unexpected frame type');
    }

    // The only part of a content frame the relay reads: the sender prefix, so a
    // peer cannot claim to be someone else. The ciphertext is never touched.
    let sender;
    try {
      ({ sender } = decodeSealed(frame.payload));
    } catch {
      return fail(CLOSE.BAD_FRAME, 'malformed sealed frame');
    }
    if (sender !== username) return fail(CLOSE.BAD_FRAME, 'sender does not match token');

    conn.bytesIn += data.length;
    conn.frames += 1;
    conn.lastActiveAt = Date.now();

    for (const peer of room.conns) {
      if (peer === conn) continue;
      if (peer.ws.readyState === peer.ws.OPEN) {
        peer.ws.send(data, { binary: true });
        peer.bytesOut += data.length;
      }
    }
  });

  const cleanup = () => {
    rooms.detach(room, conn);
    broadcastControl(room, conn, { type: 'peer-left', peer: username });
    log(`${username} left ${owner}/${session} (${room.conns.size} peer(s))`);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function broadcastControl(room, except, msg) {
  const frame = encodeControl(msg);
  for (const peer of room.conns) {
    if (peer === except) continue;
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(frame, { binary: true });
  }
}

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`token auth: Ed25519 JWT${ephemeralKey ? ' (ephemeral key — tokens die with this process)' : ''}`);
  if (DEV_AUTH) log('DEV AUTH ENABLED — /v1/auth/dev mints tokens for any username');
});

const shutdown = () => {
  log('shutting down');
  for (const room of rooms.rooms.values()) {
    for (const conn of room.conns) conn.ws.close(CLOSE.SERVER_SHUTDOWN, 'relay restarting');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
