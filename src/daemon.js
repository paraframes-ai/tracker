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

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import chokidar from 'chokidar';
import diff from 'fast-diff';
import DiffMatchPatch from 'diff-match-patch';
import picomatch from 'picomatch';

import { detectEol, fromLf, platformEol, toLf } from './eol.js';
import { EncryptedProvider } from './provider.js';
import { notify } from './notify.js';
import { startAutosave } from './autosave.js';

// Transactions we originate from local disk carry this origin, so the CRDT
// observer can tell "the other dev edited this" from "I just mirrored my own
// disk change into the CRDT" and avoid writing our own edits back to disk.
const LOCAL = 'local-disk';

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // skip anything larger; not a source file

const execFileP = promisify(execFile);

// Ask git what the project considers real files. `ls-files -co --exclude-standard`
// lists tracked plus untracked files while honouring .gitignore, nested
// .gitignores, .git/info/exclude and the global excludes file — which is exactly
// the "what is build output" question, already answered correctly by the project
// for its own toolchain.
//
// Returns null when the root is not a git repo (or git is unavailable), and the
// caller falls back to walking the tree.
export async function gitCandidates(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const rels = stdout.split('\0').filter(Boolean);
    return new Set(rels);
  } catch {
    return null;
  }
}

// Is this newly-created path something git would ignore? Used for files that
// appear after startup, so a build kicked off mid-session does not start
// replicating its output.
export async function gitIgnores(root, rel) {
  try {
    await execFileP('git', ['-C', root, 'check-ignore', '-q', '--', rel]);
    return true; // exit 0 means "ignored"
  } catch (err) {
    return err.code === 1 ? false : false; // 1 = not ignored; anything else, allow
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);
const warn = (msg) => console.warn(`[${stamp()}] ⚠️  ${msg}`);

// What would this configuration actually sync? Uses the same rules as the real
// scan — including .gitignore — so the preview cannot disagree with what happens
// next. Exported so the CLI can show it, and refuse, *before* anything is
// written or uploaded.
export async function previewScan(config) {
  const includeMatch = picomatch(config.include, { dot: true });
  const excludeMatch = picomatch(config.exclude, { dot: true });
  const shouldSync = (rel) => rel !== '' && includeMatch(rel) && !excludeMatch(rel);
  const toRel = (abs) => path.relative(config.root, abs).split(path.sep).join('/');

  const gitSet = await gitCandidates(config.root);
  const rels = [];

  if (gitSet) {
    for (const rel of gitSet) if (shouldSync(rel)) rels.push(rel);
  } else {
    const walk = async (dir) => {
      if (rels.length > 50_000) return; // far past any sane project
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable (macOS privacy protections, permissions)
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = toRel(abs);
        if (excludeMatch(rel)) continue;
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile() && shouldSync(rel)) rels.push(rel);
      }
    };
    await walk(config.root);
  }

  let bytes = 0;
  const topLevel = new Map();
  for (const rel of rels) {
    const stat = await fsp.stat(path.join(config.root, ...rel.split('/'))).catch(() => null);
    if (stat) bytes += stat.size;
    const top = rel.includes('/') ? `${rel.split('/')[0]}/` : rel;
    topLevel.set(top, (topLevel.get(top) || 0) + 1);
  }

  return {
    count: rels.length,
    bytes,
    gitAware: Boolean(gitSet),
    byTop: [...topLevel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

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
  // Namespaced per run. A bare counter restarted at 0 on every process start, so
  // a later session could silently overwrite the only backup of a file displaced
  // by an earlier one — the safety net destroying what it was holding.
  const trashRun = new Date().toISOString().replace(/[:.]/g, '-');
  let trashCounter = 0;
  // git's view of the project, when there is one.
  let gitSet = null;
  const ignoreCache = new Map();
  // Paths a peer offered that our own rules forbid; tracked so the warning is
  // logged once each rather than on every update.
  const refusedIncoming = new Set();
  // Per-file "base": the content this machine last knew both sides agreed on —
  // the last thing we wrote to disk, or the last thing we successfully published.
  // A local save is only meaningful *relative to this*, which is what makes a
  // three-way merge possible.
  const baseByFile = new Map();
  // The disk content *immediately before* the most recent remote write. An editor
  // that has not reloaded is still working from this, not from what we wrote — so
  // this, not the file on disk, is the base its next save should be judged
  // against.
  const preRemoteByFile = new Map();
  const dmp = new DiffMatchPatch();

  // Did a remote write introduce text that this saved buffer clearly never saw?
  // If so the editor is stale and its save must be merged, not trusted. If the
  // text *is* present the editor reloaded, and the ordinary path is correct —
  // getting this wrong the other way would duplicate the remote insertion.
  function editorLooksStale(local, pre, agreed) {
    if (pre === undefined || pre === agreed) return false;
    const introduced = diff(pre, agreed)
      .filter(([op]) => op === diff.INSERT)
      .map(([, text]) => text)
      .filter((text) => text.trim().length > 2);
    if (!introduced.length) return false;
    return !introduced.every((text) => local.includes(text));
  }

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

  async function scanDisk() {
    const acc = new Map();
    // In a git repo, git decides what counts as a project file — that is how
    // build output stays out without this tool knowing anything about Unity,
    // node, cargo or anything else.
    if (gitSet) {
      for (const rel of gitSet) {
        if (!shouldSync(rel)) continue;
        const read = await readText(toAbs(rel));
        if (read !== null) {
          acc.set(rel, read.text);
          if (read.eol) eolByFile.set(rel, read.eol);
        }
      }
      return acc;
    }
    return walkDisk(config.root, acc);
  }

  async function walkDisk(dir = config.root, acc = new Map()) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toRel(abs);
      if (excludeMatch(rel)) continue;
      if (entry.isDirectory()) {
        await walkDisk(abs, acc);
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
    const dest = path.join(config.root, '.pf-sync-trash', `${rel}${suffix}.${trashRun}.${trashCounter++}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(abs, dest);
  }

  async function backupToTrash(rel) {
    const abs = toAbs(rel);
    const dest = path.join(config.root, '.pf-sync-trash', `${rel}.local.${trashRun}.${trashCounter++}`);
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
    // Belt and braces: nothing excluded should ever reach the disk, whichever
    // path got us here.
    if (!shouldSync(rel)) return;
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
    // Remember what an unreloaded editor would still be holding, before we
    // replace it on disk.
    if (cur !== null) preRemoteByFile.set(rel, toLf(cur));
    // Compare in the CRDT's space, not the disk's, or a CRLF file would look
    // different on every single check and rewrite forever.
    if (cur !== null && toLf(cur) === content) return; // already current (also swallows our own echo)
    const eol = eolByFile.get(rel) ?? (cur !== null ? detectEol(cur) : null) ?? platformEol();
    eolByFile.set(rel, eol);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, fromLf(content, eol), 'utf8');
    baseByFile.set(rel, content);
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
        // The exclude list has to apply to *incoming* files too, not only to what
        // we upload. Otherwise a peer whose root is wrong — a home directory, say
        // — writes their .config/, .ssh/ and .env straight onto our disk, and our
        // own credential exclusions protect nobody.
        if (!shouldSync(key)) {
          if (!refusedIncoming.has(key)) {
            refusedIncoming.add(key);
            warn(`refusing ${key} from peer — excluded locally`);
          }
          continue;
        }
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
    // A build started mid-session would otherwise begin replicating its output.
    if (gitSet && !gitSet.has(rel)) {
      if (!ignoreCache.has(rel)) ignoreCache.set(rel, await gitIgnores(config.root, rel));
      if (ignoreCache.get(rel)) return;
    }
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
      setYText(ytext, read.text);
      baseByFile.set(rel, read.text);
      return;
    }

    const remote = ytext.toString();
    const local = read.text;
    if (remote === local) {
      baseByFile.set(rel, local);
      return;
    }

    const agreed = baseByFile.has(rel) ? baseByFile.get(rel) : remote;
    const pre = preRemoteByFile.get(rel);
    // A stale editor's save looks, on disk, exactly like a deliberate revert.
    // Distinguishing them is the whole difficulty; see editorLooksStale.
    const base = editorLooksStale(local, pre, agreed) ? pre : agreed;

    // Nothing arrived from a peer since we last agreed, so the saved file is a
    // straightforward advance on the shared state.
    if (remote === base) {
      setYText(ytext, local);
      baseByFile.set(rel, local);
      return;
    }

    // Otherwise both sides moved. Treating the saved file as truth here is what
    // silently erased peers' edits: an editor writes the whole buffer, including
    // the parts it never saw change. So publish only *this* editor's delta
    // (base -> local) applied on top of the shared state.
    const patches = dmp.patch_make(base, local);
    const [merged, applied] = dmp.patch_apply(patches, remote);
    const clean = applied.every(Boolean);

    if (!clean) {
      // Genuinely overlapping edits. Keep a copy of what this machine saved
      // before the merge replaces it, so nothing is lost silently.
      await backupToTrash(rel).catch(() => {});
      warn(
        `${rel}: your save overlapped a change from a collaborator — merged, ` +
          `your version saved to .pf-sync-trash/`,
      );
    }

    setYText(ytext, merged);
    baseByFile.set(rel, merged);
    // Put the merged result on disk too, or the editor keeps a buffer that
    // disagrees with the shared state and re-fights on every save.
    if (merged !== local) scheduleDiskWrite(rel);
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
      baseByFile.set(rel, remote);
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
      baseByFile.set(rel, content);
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
      const previous = lastPeers ? lastPeers.split(',') : [];
      lastPeers = key;
      if (peers.length) {
        log(`👥 online with: ${peers.join(', ')}`);
        // A detached session logs to a file nobody reads, so the arrival of a
        // collaborator is worth surfacing where it will be seen.
        const arrived = peers.filter((p) => !previous.includes(p));
        if (arrived.length) notify('ParaFrames Live', `${arrived.join(', ')} joined the session`);
      } else {
        log('👥 no other collaborators online');
        if (previous.length) notify('ParaFrames Live', `${previous.join(', ')} left the session`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------------
  log('ParaFrames Live');
  log(`root=${config.root}`);
  gitSet = await gitCandidates(config.root);
  log(
    gitSet
      ? `respecting .gitignore (${gitSet.size} candidate files in the repo)`
      : 'not a git repo — falling back to the default exclude list',
  );

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
    // node's global WebSocket cannot set request headers, so the daemon supplies
    // the `ws` package explicitly (the browser viewer uses the global instead).
    const WSImpl = (await import('ws')).default;
    provider = new EncryptedProvider({
      WebSocketImpl: WSImpl,
      relay: config.relay,
      owner: config.owner,
      session: config.session,
      username: config.username,
      token: config.token,
      roomKey: config.roomKey,
      allow: config.allow,
      clientVersion: config.clientVersion,
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
      notify('ParaFrames Live — session stopped', reason);
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

  // Some editors hold unsaved text indefinitely, which makes them invisible to a
  // filesystem watcher. Where one can be asked to save, ask it.
  const stopAutosave = config.autosave
    ? startAutosave({ ide: config.autosave, log, warn })
    : () => {};

  const shutdown = () => {
    log('shutting down');
    stopAutosave();
    provider.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// No auto-run on import. A `import.meta.url === process.argv[1]` guard here is
// not safe once this is bundled into a single executable: the two can coincide,
// so merely importing runSync would start a legacy daemon on every command. The
// legacy entry point lives in src/pf-sync.js instead.
