// Tracking of detached sessions, so `tracker share --detach` can hand the
// terminal back and `status` / `stop` / `logs` can find what is running.
//
// One small JSON file plus one log file per session, keyed by owner--session.
// No daemon registry and no IPC: liveness is "does this pid still exist", which
// is enough and cannot go stale in a way that lies about a running process.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'tracker');
}

// Keyed by room id *and* root: one machine can legitimately both share and join
// the same room (or sync it into two directories), and keying on the room alone
// made the second overwrite the first — leaving an orphaned background process
// that status could not see and stop could not kill.
const keyFor = (owner, session, root) => {
  const safe = `${owner}--${session}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const tag = crypto.createHash('sha256').update(root || '').digest('hex').slice(0, 8);
  return `${safe}--${tag}`;
};
export const pidFile = (owner, session, root) =>
  path.join(stateDir(), `${keyFor(owner, session, root)}.json`);
export const logFile = (owner, session, root) =>
  path.join(stateDir(), `${keyFor(owner, session, root)}.log`);

export async function ensureStateDir() {
  await fsp.mkdir(stateDir(), { recursive: true, mode: 0o700 });
  return stateDir();
}

// EPERM means the pid exists but belongs to someone else, which still counts as
// running; only ESRCH means gone.
export function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function writeSession(entry) {
  await ensureStateDir();
  await fsp.writeFile(pidFile(entry.owner, entry.session, entry.root), `${JSON.stringify(entry, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function listSessions() {
  let names = [];
  try {
    names = fs.readdirSync(stateDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(stateDir(), n), 'utf8'));
      out.push({ ...entry, running: isRunning(entry.pid) });
    } catch {
      /* unreadable or partially written — skip rather than crash `status` */
    }
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.owner.localeCompare(b.owner));
}

export async function removeSession(owner, session, root) {
  await fsp.rm(pidFile(owner, session, root), { force: true });
}

// SIGTERM first so the daemon can close its socket cleanly; escalate only if it
// ignores that.
export async function stopSession(entry, { timeoutMs = 5000 } = {}) {
  if (!isRunning(entry.pid)) {
    await removeSession(entry.owner, entry.session, entry.root);
    return 'not running';
  }
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch {
    await removeSession(entry.owner, entry.session, entry.root);
    return 'not running';
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (!isRunning(entry.pid)) {
      await removeSession(entry.owner, entry.session, entry.root);
      return 'stopped';
    }
  }
  try {
    process.kill(entry.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  await removeSession(entry.owner, entry.session, entry.root);
  return 'killed';
}

// Re-launching ourselves detached has to work both from source (execPath is
// node/bun, so argv[1] is the script) and from a compiled single binary (execPath
// *is* the program, and argv[1] is a virtual path that must not be passed on —
// note fs.existsSync returns true for it, so that cannot be used to tell them
// apart).
export function selfCommand(args) {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  const runningFromSource = base === 'node' || base === 'bun' || base === 'node.exe' || base === 'bun.exe';
  if (runningFromSource && process.argv[1]) return { cmd: exe, args: [process.argv[1], ...args] };
  return { cmd: exe, args };
}
