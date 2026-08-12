#!/usr/bin/env node
/*
 * ParaFrames Live — sync daemon.
 *
 * Runs on each developer's machine. It:
 *   1. Connects to the relay and joins a shared CRDT document (one Yjs doc per
 *      project "room").
 *   2. Watches the project folder for file changes and mirrors them into the
 *      CRDT (disk -> CRDT).
 *   3. Watches the CRDT for changes made by the other developer and writes the
 *      merged result back to disk (CRDT -> disk).
 *
 * Because the shared document is a CRDT (Yjs), simultaneous edits to the same
 * file — even the same line — merge automatically with no conflict prompt.
 *
 * Two transports are supported:
 *   - 'e2e'    hosted/authenticated relay, end-to-end encrypted (RFC 001)
 *   - 'legacy' the original shared-secret relay (src/relay.cjs), unencrypted
 *
 * IMPORTANT baseline rule: before starting the daemon, both developers should
 * be on the same git commit with a clean working tree (a normal `git pull`).
 * The live layer keeps you in sync from that shared starting point; it is not
 * a way to reconcile two piles of divergent offline work.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import chokidar from 'chokidar';
import diff from 'fast-diff';
import picomatch from 'picomatch';

import { detectEol, fromLf, platformEol, toLf } from './eol.js';
import { EncryptedProvider } from './provider.js';

// Transactions we originate from local disk carry this origin, so the CRDT
// observer can tell "the other dev edited this" from "I just mirrored my own
// disk change into the CRDT" and avoid writing our own edits back to disk.
const LOCAL = 'local-disk';

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // skip anything larger; not a source file

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);
const warn = (msg) => console.warn(`[${stamp()}] ⚠️  ${msg}`);

export async function runSync(config) {
  const doc = new Y.Doc();
  const files = doc.getMap('files'); // relPath -> Y.Text

  const toRel = (abs) => path.relative(config.root, abs).split(path.sep).join('/');
  const toAbs = (rel) => path.join(config.root, ...rel.split('/'));

  const includeMatch = picomatch(config.include, { dot: true });
  const excludeMatch = picomatch(config.exclude, { dot: true });
  const shouldSync = (rel) => rel !== '' && includeMatch(rel) && !excludeMatch(rel);

  const observed = new Map(); // rel -> observer fn (so we don't double-attach)
  const writeTimers = new Map();
  // Each file keeps whatever line ending it already had on *this* machine. The
  // CRDT holds LF only; see src/eol.js for why.
  const eolByFile = new Map();
  let trashCounter = 0;

  // -------------------------------------------------------------------------
  // file helpers
  // -------------------------------------------------------------------------
  async function readText(abs) {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return null; // looks binary
    const raw = buf.toString('utf8');
    return { text: toLf(raw), eol: detectEol(raw) };
  }

  async function scanDisk(dir = config.root, acc = new Map()) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toRel(abs);
      if (excludeMatch(rel)) continue;
      if (entry.isDirectory()) {
        await scanDisk(abs, acc);
      } else if (entry.isFile() && shouldSync(rel)) {
        const read = await readText(abs);
        if (read !== null) {
          acc.set(rel, read.text);
          if (read.eol) eolByFile.set(rel, read.eol);
        }
      }
    }
    return acc;
  }

  async function moveToTrash(rel, suffix = '') {
    const abs = toAbs(rel);
    try {
      await fsp.access(abs);
    } catch {
      return; // nothing to move
    }
    const dest = path.join(config.root, '.pf-sync-trash', `${rel}${suffix}.${trashCounter++}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(abs, dest);
  }

  async function backupToTrash(rel) {
    const abs = toAbs(rel);
    const dest = path.join(config.root, '.pf-sync-trash', `${rel}.local.${trashCounter++}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(abs, dest);
  }

  // -------------------------------------------------------------------------
  // CRDT <-> disk plumbing
  // -------------------------------------------------------------------------

  // Apply a full string to a Y.Text as a minimal set of insert/delete ops, so we
  // preserve concurrent edits from the other side instead of clobbering them.
  function setYText(ytext, next) {
    const cur = ytext.toString();
    if (cur === next) return;
    doc.transact(() => {
      let i = 0;
      for (const [op, text] of diff(cur, next)) {
        if (op === diff.EQUAL) i += text.length;
        else if (op === diff.INSERT) {
          ytext.insert(i, text);
          i += text.length;
        } else {
          ytext.delete(i, text.length);
        }
      }
    }, LOCAL);
  }

  function scheduleDiskWrite(rel) {
    clearTimeout(writeTimers.get(rel));
    writeTimers.set(
      rel,
      setTimeout(() => {
        writeTimers.delete(rel);
        writeToDisk(rel).catch((err) => warn(`write ${rel}: ${err.message}`));
      }, 50),
    );
  }

  async function writeToDisk(rel) {
    const ytext = files.get(rel);
    if (!ytext) return;
    const content = ytext.toString(); // canonical LF
    const abs = toAbs(rel);
    let cur = null;
    try {
      cur = await fsp.readFile(abs, 'utf8');
    } catch {
      /* new file */
    }
    // Compare in the CRDT's space, not the disk's, or a CRLF file would look
    // different on every single check and rewrite forever.
    if (cur !== null && toLf(cur) === content) return; // already current (also swallows our own echo)
    const eol = eolByFile.get(rel) ?? (cur !== null ? detectEol(cur) : null) ?? platformEol();
    eolByFile.set(rel, eol);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, fromLf(content, eol), 'utf8');
    log(`⇩ ${rel}`);
  }

  // Attach an observer to a file's Y.Text so remote edits get written to disk.
  function ensureObserved(rel) {
    if (observed.has(rel)) return;
    const ytext = files.get(rel);
    if (!ytext) return;
    const obs = (_event, tr) => {
      if (tr.origin === LOCAL) return; // our own disk-originated edit; disk is current
      scheduleDiskWrite(rel);
    };
    ytext.observe(obs);
    observed.set(rel, obs);
  }

  // React to files being created/deleted in the shared doc by the other dev.
  files.observe((event, tr) => {
    for (const [key, change] of event.keys) {
      if (change.action === 'add') {
        ensureObserved(key);
        if (tr.origin !== LOCAL) scheduleDiskWrite(key);
      } else if (change.action === 'delete') {
        observed.delete(key);
        if (tr.origin !== LOCAL) {
          moveToTrash(key)
            .then(() => log(`🗑  ${key} (deleted by peer → moved to .pf-sync-trash)`))
            .catch((err) => warn(`trash ${key}: ${err.message}`));
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // local disk -> CRDT
  // -------------------------------------------------------------------------
  async function onLocalUpsert(abs) {
    const rel = toRel(abs);
    if (!shouldSync(rel)) return;
    const read = await readText(abs);
    if (read === null) return;
    if (read.eol) eolByFile.set(rel, read.eol);

    let ytext = files.get(rel);
    if (!ytext) {
      doc.transact(() => {
        ytext = new Y.Text();
        files.set(rel, ytext);
      }, LOCAL);
      ensureObserved(rel);
    }
    setYText(ytext, read.text);
  }

  function onLocalUnlink(abs) {
    const rel = toRel(abs);
    if (!shouldSync(rel)) return;
    if (!files.has(rel)) return;
    doc.transact(() => files.delete(rel), LOCAL);
    log(`✖ ${rel} (deleted locally → removed for peer)`);
  }

  // -------------------------------------------------------------------------
  // startup
  // -------------------------------------------------------------------------
  async function reconcile() {
    const disk = await scanDisk();
    const crdtKeys = new Set(files.keys());

    // Files the shared doc already has: shared copy is source of truth.
    for (const rel of crdtKeys) {
      ensureObserved(rel);
      const remote = files.get(rel).toString();
      if (!disk.has(rel)) {
        await writeToDisk(rel); // peer has a file we don't — pull it down
      } else if (disk.get(rel) !== remote) {
        warn(
          `${rel}: your local copy differs from the shared copy at startup — ` +
            `adopting the shared version (your local copy saved to .pf-sync-trash). ` +
            `Tip: git pull to a clean tree before starting to avoid this.`,
        );
        await backupToTrash(rel);
        await writeToDisk(rel);
      }
    }

    // Files only we have: contribute them to the shared doc.
    for (const [rel, content] of disk) {
      if (crdtKeys.has(rel)) continue;
      doc.transact(() => {
        const ytext = new Y.Text();
        ytext.insert(0, content);
        files.set(rel, ytext);
      }, LOCAL);
      ensureObserved(rel);
    }

    log(`reconciled: ${files.size} file(s) in the shared session`);
  }

  function watch() {
    const watcher = chokidar.watch(config.root, {
      ignoreInitial: true, // reconcile() already handled the current tree
      ignored: (p) => excludeMatch(toRel(p)),
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });
    watcher
      .on('add', (p) => onLocalUpsert(p).catch((e) => warn(e.message)))
      .on('change', (p) => onLocalUpsert(p).catch((e) => warn(e.message)))
      .on('unlink', (p) => onLocalUnlink(p));
    log(`watching ${config.root}`);
  }

  function connectPresence(awareness) {
    awareness.setLocalStateField('user', { name: config.name });
    let lastPeers = '';
    awareness.on('change', () => {
      const peers = [...awareness.getStates().entries()]
        .filter(([id]) => id !== awareness.clientID)
        .map(([, s]) => s.user?.name)
        .filter(Boolean)
        .sort();
      const key = peers.join(',');
      if (key === lastPeers) return;
      lastPeers = key;
      if (peers.length) log(`👥 online with: ${peers.join(', ')}`);
      else log('👥 no other collaborators online');
    });
  }

  // -------------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------------
  log('ParaFrames Live');
  log(`root=${config.root}`);

  let provider;
  if (config.mode === 'legacy') {
    // The original unencrypted shared-secret relay. Kept working on purpose so
    // existing self-hosted deployments do not break (RFC 001 §11).
    const { WebsocketProvider } = await import('y-websocket');
    const WS = (await import('ws')).default;
    log(`room=${config.room} relay=${config.relay} name=${config.name} (legacy, unencrypted)`);
    provider = new WebsocketProvider(config.relay, config.room, doc, {
      WebSocketPolyfill: WS,
      params: config.token ? { token: config.token } : {},
      connect: true,
    });
    provider.on('status', ({ status }) => log(`relay: ${status}`));
  } else {
    log(
      `session=${config.owner}/${config.session} relay=${config.relay} ` +
        `as=${config.username} name=${config.name}`,
    );
    provider = new EncryptedProvider({
      relay: config.relay,
      owner: config.owner,
      session: config.session,
      username: config.username,
      token: config.token,
      roomKey: config.roomKey,
      allow: config.allow,
      doc,
    });
    provider.on('status', ({ status, reason }) =>
      log(`relay: ${status}${reason ? ` (${reason})` : ''}`),
    );
    provider.on('relay-error', (msg) => warn(`relay: ${msg.code} ${msg.reason ?? ''}`));
    provider.on('peer-key-mismatch', (peer) =>
      warn(`ignoring ${peer}: their invite key does not match this session`),
    );
    provider.on('sync-timeout', () =>
      warn('no peer sent its state within 10s — proceeding with local files as the baseline'),
    );
    provider.on('fatal', ({ code, reason }) => {
      console.error(`[${stamp()}] ✖ ${reason} (${code})`);
      process.exit(1);
    });
    await provider.connect();
  }

  connectPresence(provider.awareness);

  // Wait for the first successful sync so reconcile() sees the shared state.
  await new Promise((resolve) => {
    if (provider.synced) return resolve();
    provider.once('sync', () => resolve());
  });
  log('synced with relay');

  await reconcile();
  watch();

  const shutdown = () => {
    log('shutting down');
    provider.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Direct invocation keeps the original flag interface working:
//   node src/daemon.js --relay=... --room=... --token=... --root=...
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  runSync({ ...config, mode: 'legacy' }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
