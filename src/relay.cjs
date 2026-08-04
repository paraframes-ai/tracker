/*
 * ParaFrames Live — relay server.
 *
 * A thin WebSocket server that routes Yjs sync/awareness messages between
 * connected daemons. It stores nothing on disk and understands nothing about
 * files — it just relays CRDT updates, so the actual merge happens in each
 * client. One relay can host many independent "rooms" (projects).
 *
 * Deploy this anywhere both developers can reach (a small VPS, Fly.io, a
 * Raspberry Pi with a tunnel, etc.). For anything beyond a trusted LAN, put it
 * behind TLS (wss://) and set PF_RELAY_TOKEN.
 *
 * Env:
 *   PORT             (default 1234)
 *   HOST             (default 0.0.0.0)
 *   PF_RELAY_TOKEN   optional shared secret; clients must pass ?token=... to match
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');

const PORT = Number(process.env.PORT || 1234);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.PF_RELAY_TOKEN || '';

const server = http.createServer((req, res) => {
  // Basic health check so you can curl the relay to see it's alive.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('paraframes-live relay ok\n');
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (conn, req) => {
  // The URL path is the room/doc name (WebsocketProvider appends it).
  setupWSConnection(conn, req);
});

server.on('upgrade', (req, socket, head) => {
  if (TOKEN) {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ws://${HOST}:${PORT}`);
  if (TOKEN) console.log('[relay] token auth: ON');
  else console.log('[relay] token auth: OFF (set PF_RELAY_TOKEN for a shared secret)');
});
