// Encrypted Yjs provider.
//
// Replaces y-websocket's WebsocketProvider. The difference that matters: the old
// relay held the authoritative Yjs document and answered sync requests itself.
// This relay cannot — it only sees ciphertext — so peers sync *with each other*
// and the relay is pure fan-out.
//
// Consequence for startup: whether we are "synced" is no longer "the server
// replied", it is either "the relay told us we are alone in the room" (so there
// is nothing to sync and we seed from disk) or "a peer sent us its state".
// reconcile() depends on this being correct — declaring sync too early would let
// us seed a room whose shared copy we had not yet seen.

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { EventEmitter } from 'node:events';

import {
  FRAME,
  PROTOCOL_VERSION,
  decodeControl,
  decodeFrame,
  decodeSealed,
  encodeControl,
  encodeFrame,
  encodeSealed,
} from './protocol.js';
import { importRoomKey, open, seal } from './crypto.js';

const SYNC_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
// How long a connection must survive before we consider it healthy enough to
// reset the reconnect backoff.
const CONNECTION_STABLE_MS = 5_000;

export class EncryptedProvider extends EventEmitter {
  constructor({
    relay,
    owner,
    session,
    username,
    token,
    roomKey,
    doc,
    awareness,
    allow,
    clientVersion,
    // Injected so the same provider runs under node (the `ws` package, which can
    // set an Authorization header) and in a browser (native WebSocket, which
    // cannot — it passes the token as a subprotocol instead). Defaulting to the
    // global rather than importing `ws` here keeps this file bundleable for the
    // browser, where importing `ws` would fail.
    WebSocketImpl = globalThis.WebSocket,
    readOnly = false,
  }) {
    super();
    this.WS = WebSocketImpl;
    this.readOnly = readOnly;
    this.relay = relay.replace(/\/+$/, '');
    this.owner = owner;
    this.session = session;
    this.username = username;
    this.token = token;
    this.rawKey = roomKey;
    this.doc = doc;
    // Awareness runs its own outdated-state timer, so whoever creates it has to
    // destroy it — otherwise the process keeps a live handle after destroy().
    this._ownsAwareness = !awareness;
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc);
    this.allow = allow && allow.length ? allow : null;
    this.clientVersion = clientVersion || null;

    this.key = null;
    this.ws = null;
    this.synced = false;
    this.peers = new Set();
    this.destroyed = false;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.pingTimer = null;

    // Distinguishing "my key is wrong" from "some other peer's key is wrong".
    // Only the former should be fatal: otherwise one peer connecting with a bad
    // key takes down everyone else's session, which is a trivial denial of
    // service against the room owner.
    this.initialPeers = new Set();
    this.decryptedOk = false;
    this.badSenders = new Set();

    this._syncedResolve = null;
    this.whenSynced = new Promise((resolve) => {
      this._syncedResolve = resolve;
    });

    this._onDocUpdate = (update, origin) => {
      if (origin === this) return; // came from a peer; don't echo it back
      if (this.readOnly) return; // a viewer observes; it never contributes edits
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this._sendSealed(FRAME.CONTENT, encoding.toUint8Array(enc));
    };
    this.doc.on('update', this._onDocUpdate);

    this._onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changed = added.concat(updated, removed);
      const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      this._sendSealed(FRAME.AWARENESS, payload);
    };
    this.awareness.on('update', this._onAwarenessUpdate);
  }

  ctxFor(sender) {
    return { owner: this.owner, session: this.session, sender };
  }

  async connect() {
    this.key = await importRoomKey(this.rawKey);
    this._open();
    return this;
  }

  _url() {
    const base = this.relay.replace(/^http/, 'ws');
    const url = `${base}/v${PROTOCOL_VERSION}/rooms/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.session)}`;
    // The allowlist is applied by the relay at room creation, so it has to reach
    // it on the connect URL — usernames are authenticated, so this is the one
    // access check the relay can actually enforce.
    const params = new URLSearchParams();
    if (this.allow) params.set('allow', this.allow.join(','));
    // Lets the relay refuse a client too old to speak its protocol, with a
    // message naming the version rather than a puzzling failure later.
    if (this.clientVersion) params.set('client', `tracker/${this.clientVersion}`);
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  _open() {
    if (this.destroyed) return;
    // Bearer token goes in a header, not the query string, so it stays out of
    // the relay's access logs. Browsers cannot set headers on a WebSocket, so
    // there the token rides in the subprotocol instead — same reasoning, since a
    // subprotocol is also not logged as part of the URL.
    const Impl = this.WS;
    const browserLike = typeof Impl.prototype?.addEventListener === 'function' && !Impl.Server;
    const ws = browserLike
      ? new Impl(this._url(), [`bearer.${this.token}`])
      : new Impl(this._url(), { headers: { Authorization: `Bearer ${this.token}` } });
    ws.binaryType = browserLike ? 'arraybuffer' : 'nodebuffer';
    this.ws = ws;

    const openedAt = Date.now();

    const onOpen = () => {
      this.emit('status', { status: 'connected' });
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(encodeFrame(FRAME.PING));
      }, PING_INTERVAL_MS);
    };

    const onMessage = (data) => {
      this._onMessage(data).catch((err) => this.emit('error', err));
    };

    const onClose = (code, reason) => this._afterClose(code, reason, openedAt);

    if (browserLike) {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', (ev) => onMessage(new Uint8Array(ev.data)));
      ws.addEventListener('close', (ev) => onClose(ev.code, ev.reason || ''));
      ws.addEventListener('error', () =>
        this.emit('status', { status: 'error', reason: 'websocket error' }),
      );
    } else {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', (code, reasonBuf) => onClose(code, reasonBuf?.toString() || ''));
      ws.on('error', (err) => this.emit('status', { status: 'error', reason: err.message }));
    }

  }

  _afterClose(code, reason, openedAt) {
    clearInterval(this.pingTimer);
    this.emit('status', { status: 'disconnected', code, reason });
    // 4001/4003/4004 are terminal: bad token, not allowed, no such room.
    // Retrying those just spins, so surface them and stop.
    if (code === 4001 || code === 4003 || code === 4004) {
      this.emit('fatal', { code, reason });
      return;
    }
    // An oversized frame is not transient: reconnecting resends exactly the
    // same data and gets refused identically. Say something actionable instead
    // of looping forever looking connected.
    if (reason === 'maxFrameBytes') {
      this.emit('fatal', {
        code,
        reason:
          'this project is too large for the relay to sync in one message ' +
          '(initial sync exceeded the relay frame limit)',
      });
      return;
    }
    if (this.destroyed) return;
    // Only treat the connection as healthy — and reset backoff — if it actually
    // stayed up. Resetting on 'open' meant a connection that died immediately
    // reconnected at full speed forever instead of backing off.
    if (Date.now() - openedAt > CONNECTION_STABLE_MS) {
      this.reconnectDelay = RECONNECT_BASE_MS;
    }
    setTimeout(() => this._open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  async _onMessage(data) {
    const { type, payload } = decodeFrame(data);

    if (type === FRAME.PING) return;

    if (type === FRAME.CONTROL) {
      this._onControl(decodeControl(payload));
      return;
    }

    if (type !== FRAME.CONTENT && type !== FRAME.AWARENESS) return;

    const { sender, sealed } = decodeSealed(payload);
    // Deliberately NOT skipping frames whose sender matches our own username: one
    // person syncing a laptop and a desktop is two connections under the same
    // account, and dropping those meant their edits never reached each other.
    // Processing a frame we somehow sent ourselves is harmless — Yjs updates are
    // idempotent — so there is nothing to guard against here.
    if (this.badSenders.has(sender)) return; // already known to be using a different key

    let plaintext;
    try {
      plaintext = await open(this.key, type, this.ctxFor(sender), sealed);
    } catch {
      // Wrong key, tampering, or a relay lying about the sender all land here.
      // Whose fault it is decides whether this is fatal: if we joined a room that
      // already had peers and have never decrypted anything from one of them,
      // it is our invite key that is wrong — the single most likely user error,
      // so say so loudly and stop. Anything else means some *other* peer is using
      // a different key, and we simply ignore them; treating that as fatal would
      // let any stranger who can reach the room end the owner's session.
      if (!this.decryptedOk && this.initialPeers.has(sender)) {
        this.emit('fatal', {
          code: 'BAD_KEY',
          reason: 'invite key does not match this session (frame failed to decrypt)',
        });
      } else {
        this.badSenders.add(sender);
        this.emit('peer-key-mismatch', sender);
      }
      return;
    }
    this.decryptedOk = true;

    if (type === FRAME.AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, plaintext, this);
      return;
    }

    const decoder = decoding.createDecoder(plaintext);
    const reply = encoding.createEncoder();
    const msgType = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
    if (encoding.length(reply) > 0) {
      this._sendSealed(FRAME.CONTENT, encoding.toUint8Array(reply));
    }
    // A step2 means a peer has handed us its state — that is what "synced" means
    // when there is no authoritative server document.
    if (msgType === syncProtocol.messageYjsSyncStep2) this._markSynced();
  }

  _onControl(msg) {
    if (msg.type === 'hello') {
      this.peers = new Set(msg.peers ?? []);
      // Peers already present when we arrive are the ones whose frames we must
      // be able to decrypt; a failure from them means our key is wrong.
      this.initialPeers = new Set(this.peers);
      // Room membership is re-established from scratch here, so forget any peer
      // we had written off — otherwise a peer who reconnects with a corrected
      // invite key stays permanently ignored.
      this.badSenders.clear();
      this.emit('peers', [...this.peers]);
      if (this.peers.size === 0) {
        // We are first in. Nothing to receive; our disk state seeds the room.
        this._markSynced();
      } else {
        this._sendSyncStep1();
        this._sendLocalAwareness();
        setTimeout(() => {
          if (!this.synced) {
            this.emit('sync-timeout');
            this._markSynced();
          }
        }, SYNC_TIMEOUT_MS);
      }
      return;
    }

    if (msg.type === 'peer-joined') {
      this.peers.add(msg.peer);
      // A fresh connection deserves a fresh judgement on its key.
      this.badSenders.delete(msg.peer);
      this.emit('peers', [...this.peers]);
      // Exchange in both directions: their step1 tells us what they lack, ours
      // tells them what we lack.
      this._sendSyncStep1();
      this._sendLocalAwareness();
      return;
    }

    if (msg.type === 'peer-left') {
      this.peers.delete(msg.peer);
      this.badSenders.delete(msg.peer);
      this.emit('peers', [...this.peers]);
      return;
    }

    if (msg.type === 'error') {
      this.emit('relay-error', msg);
    }
  }

  _markSynced() {
    if (this.synced) return;
    this.synced = true;
    this.emit('sync');
    this._syncedResolve?.();
  }

  _sendSyncStep1() {
    const enc = encoding.createEncoder();
    syncProtocol.writeSyncStep1(enc, this.doc);
    this._sendSealed(FRAME.CONTENT, encoding.toUint8Array(enc));
  }

  _sendLocalAwareness() {
    const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
      this.doc.clientID,
    ]);
    this._sendSealed(FRAME.AWARENESS, payload);
  }

  _sendSealed(type, plaintext) {
    if (!this.key || this.ws?.readyState !== 1) return;
    seal(this.key, type, this.ctxFor(this.username), plaintext)
      .then((sealed) => {
        if (this.ws?.readyState === 1) {
          this.ws.send(encodeSealed(type, this.username, sealed));
        }
      })
      .catch((err) => this.emit('error', err));
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pingTimer);
    this.doc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);
    if (this._ownsAwareness) this.awareness.destroy();
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

export { Y, awarenessProtocol };
