// Persistent room keys.
//
// `share` used to mint a fresh key on every run, so every restart — of the
// daemon, the relay, or the laptop — invalidated the invite and the collaborator
// had to be sent a new sixty-character string. That is the single most repeated
// piece of manual work in using this.
//
// Keys are per (owner, session, root) and live beside the auth token. Same
// project, same invite, indefinitely. `--new-key` rotates deliberately, which is
// what you want if an invite leaks.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { configDir } from './auth.js';
import { fromBase64Url, generateRoomKey, toBase64Url } from './crypto.js';

const keysPath = () => path.join(configDir(), 'rooms.json');

// Keyed by root as well as room id: the same session name in two checkouts is
// two different collaborations, and sharing a key between them would be wrong.
const entryKey = (owner, session, root) =>
  `${owner}/${session}@${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(keysPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function loadRoomKey(owner, session, root) {
  const raw = readAll()[entryKey(owner, session, root)];
  if (!raw) return null;
  try {
    return fromBase64Url(raw);
  } catch {
    return null; // corrupt entry; a fresh key is better than refusing to start
  }
}

export async function saveRoomKey(owner, session, root, key) {
  const all = readAll();
  all[entryKey(owner, session, root)] = toBase64Url(key);
  await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
  // 0600 from creation — this file is as sensitive as the invites it reproduces.
  await fsp.writeFile(keysPath(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

// Returns the existing key for this project, or mints and stores one.
export async function roomKeyFor(owner, session, root, { rotate = false } = {}) {
  if (!rotate) {
    const existing = loadRoomKey(owner, session, root);
    if (existing) return { key: existing, reused: true };
  }
  const key = generateRoomKey();
  await saveRoomKey(owner, session, root, key);
  return { key, reused: false };
}
