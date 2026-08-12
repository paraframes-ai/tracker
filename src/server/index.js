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

const keys = loadOrCreateKeyPair(process.env.TRACKER_JWT_PRIVATE_KEY);
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
  const conn = { ws, username, limiter: new RateLimiter() };

  const fail = (code, reason) => {
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

    for (const peer of room.conns) {
      if (peer === conn) continue;
      if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data, { binary: true });
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
  log(`token auth: Ed25519 JWT${process.env.TRACKER_JWT_PRIVATE_KEY ? '' : ' (ephemeral key — tokens die with this process)'}`);
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
