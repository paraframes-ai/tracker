#!/usr/bin/env node
// tracker — command line interface (RFC 001 §12).
//
//   tracker login|logout|whoami|status
//   tracker share [path] [--session=name] [--allow=a,b]
//   tracker join  <owner/session#key> [--root=path]
//
// The legacy self-hosted flags (--relay/--room/--token) still work via
// `tracker sync`, which is the original daemon entry point unchanged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearAuth, devLogin, forgejoLogin, loadAuth, login, readSecretFromStdin } from './auth.js';
import { fromBase64Url, generateRoomKey, toBase64Url } from './crypto.js';
import { runSync } from './daemon.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from './config.js';

// Not yet operational — RFC 001 §14 open question 2 (hosted domain and who
// operates it). Override with --relay or PF_RELAY until that is settled.
const DEFAULT_RELAY = process.env.PF_RELAY || 'wss://relay.paraframes.dev';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

function requireAuth() {
  const auth = loadAuth();
  if (!auth?.token) die('not logged in — run: tracker login');
  return auth;
}

const relayFor = (flags, auth) => flags.relay || auth?.relay || DEFAULT_RELAY;

const syncDefaults = (flags, root) => ({
  root: path.resolve(root),
  name: flags.name || os.userInfo().username || 'anon',
  include: DEFAULT_INCLUDE,
  exclude: DEFAULT_EXCLUDE,
});

// -- commands ---------------------------------------------------------------

async function cmdLogin(flags) {
  const relay = relayFor(flags, null);

  // Self-hosted identity: exchange a Forgejo access token. Prefer piping it in
  // so it stays out of argv (visible to `ps`) and out of shell history:
  //   printf '%s' "$TOKEN" | tracker login --forgejo-token
  if (flags['forgejo-token']) {
    const supplied = flags['forgejo-token'];
    const forgejoToken =
      supplied === true ? await readSecretFromStdin() : String(supplied).trim();
    if (!forgejoToken) die('no token supplied on stdin');
    const out = await forgejoLogin({ relay, forgejoToken });
    console.log(`\u2713 logged in as ${out.username} (forgejo, relay ${relay})`);
    return;
  }

  if (flags.dev) {
    // Dev path: the relay mints a token directly. Only works against a relay
    // started with TRACKER_DEV_AUTH=1.
    const username = String(flags.dev).toLowerCase();
    if (!NAME_RE.test(username)) die(`invalid username: ${username}`);
    const out = await devLogin({ relay, username });
    console.log(`✓ logged in as ${out.username} (dev token, relay ${relay})`);
    return;
  }
  const out = await login({
    relay,
    onPrompt: ({ uri, code }) => {
      console.log(`→ visit ${uri} and enter code: ${code}`);
      console.log('  waiting for authorization...');
    },
  });
  console.log(`✓ logged in as ${out.username}`);
}

async function cmdLogout() {
  await clearAuth();
  console.log('✓ logged out');
}

function cmdWhoami() {
  const auth = loadAuth();
  if (!auth?.username) die('not logged in');
  console.log(auth.username);
}

function cmdStatus() {
  const auth = loadAuth();
  console.log(`logged in: ${auth?.username ? `yes (${auth.username})` : 'no'}`);
  console.log(`relay:     ${auth?.relay || DEFAULT_RELAY}`);
  console.log(`config:    ${fs.existsSync('pf-sync.config.json') ? 'pf-sync.config.json' : 'none'}`);
  // Deliberately not claiming live session state: a running daemon is a separate
  // process and there is no IPC to it yet.
  console.log('note:      live peer/sync state is printed by the running share/join process');
}

async function cmdShare(flags, positional) {
  const auth = requireAuth();
  const root = positional[0] || process.cwd();
  if (!fs.existsSync(root)) die(`no such directory: ${root}`);

  const session = String(flags.session || path.basename(path.resolve(root))).toLowerCase();
  if (!NAME_RE.test(session)) {
    die(`invalid session name: ${session} (use a-z, 0-9, -, max 39 chars)`);
  }

  const roomKey = generateRoomKey();
  const invite = `${auth.username}/${session}#${toBase64Url(roomKey)}`;
  const relay = relayFor(flags, auth);
  const allow = flags.allow ? String(flags.allow).split(',').filter(Boolean) : null;

  console.log(`✓ session: ${auth.username}/${session}`);
  console.log('');
  console.log(`  invite:  tracker join ${invite}`);
  console.log('');
  console.log('  The part after # is the encryption key. It never reaches the relay,');
  console.log('  and anyone holding it can read and write this session — share it');
  console.log('  over a channel you trust.');
  if (allow) console.log(`  joins restricted to: ${allow.join(', ')}`);
  console.log('');

  await runSync({
    ...syncDefaults(flags, root),
    mode: 'e2e',
    relay,
    owner: auth.username,
    session,
    username: auth.username,
    token: auth.token,
    roomKey,
    allow,
  });
}

async function cmdJoin(flags, positional) {
  const auth = requireAuth();
  const target = positional[0];
  if (!target) die('usage: tracker join <owner/session#key> [--root=path]');

  const m = /^([^/]+)\/([^#]+)#(.+)$/.exec(target);
  if (!m) die('invite must look like owner/session#key');
  const owner = m[1].toLowerCase();
  const session = m[2].toLowerCase();

  let roomKey;
  try {
    roomKey = fromBase64Url(m[3]);
  } catch (err) {
    die(`bad invite key: ${err.message}`);
  }

  const root = flags.root || positional[1] || process.cwd();
  if (!fs.existsSync(root)) die(`no such directory: ${root}`);

  await runSync({
    ...syncDefaults(flags, root),
    mode: 'e2e',
    relay: relayFor(flags, auth),
    owner,
    session,
    username: auth.username,
    token: auth.token,
    roomKey,
  });
}

async function cmdSync() {
  // Unchanged legacy path for self-hosted shared-secret relays.
  const { loadConfig } = await import('./config.js');
  await runSync({ ...loadConfig(), mode: 'legacy' });
}

function usage() {
  console.log(`tracker — real-time collaborative file sync

  tracker login                        authenticate (GitHub device flow)
      --forgejo-token[=<t>]            authenticate with a Forgejo access token
                                       (omit the value to read it from stdin)
      --dev=<username>                 dev-only, needs TRACKER_DEV_AUTH=1
  tracker logout                       forget the stored token
  tracker whoami                       print the authenticated username
  tracker status                       show auth and config state

  tracker share [path]                 start a session, print an invite
      --session=<name>                 default: basename of path
      --allow=<user,...>               restrict joins by username
      --name=<label>                   display name for presence

  tracker join <owner/session#key>     attach to an existing session
      --root=<path>                    local directory to sync

  tracker sync -- [legacy flags]       self-hosted shared-secret relay

  Common: --relay=<wss://...>
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case 'login':
      return cmdLogin(flags);
    case 'logout':
      return cmdLogout();
    case 'whoami':
      return cmdWhoami();
    case 'status':
      return cmdStatus();
    case 'share':
      return cmdShare(flags, positional);
    case 'join':
      return cmdJoin(flags, positional);
    case 'sync':
      return cmdSync();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage();
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
