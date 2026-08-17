#!/usr/bin/env node
// tracker — command line interface (RFC 001 §12).
//
//   tracker login|logout|whoami|status
//   tracker share [path] [--session=name] [--allow=a,b]
//   tracker join  <owner/session#key> [--root=path]
//
// The legacy self-hosted flags (--relay/--room/--token) still work via
// `tracker sync`, which is the original daemon entry point unchanged.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearAuth, devLogin, forgejoLogin, loadAuth, login, readSecretFromStdin } from './auth.js';
import { fromBase64Url, generateRoomKey, toBase64Url } from './crypto.js';
import { previewScan, runSync } from './daemon.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from './config.js';
import { accountsUrlFor, channel, channelName } from './channel.js';
import {
  ensureStateDir,
  listSessions,
  logFile,
  selfCommand,
  stopSession,
  writeSession,
} from './session-state.js';

// Which relay to default to depends on the build channel: in-house builds point
// at the company relay, public builds at nothing, so a binary from a public
// release never silently connects to someone else's private infrastructure.
const DEFAULT_RELAY = process.env.PF_RELAY || channel.relay;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const VERSION = '0.1.1';

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

const relayFor = (flags, auth) => flags.relay || auth?.relay || DEFAULT_RELAY || null;

const syncDefaults = (flags, root) => ({
  root: path.resolve(root),
  name: flags.name || os.userInfo().username || 'anon',
  include: DEFAULT_INCLUDE,
  exclude: DEFAULT_EXCLUDE,
});


// Re-launch this same command in the background, with stdout/stderr going to a
// log file, and hand the terminal back. The room key travels in the child's
// environment rather than its argv, so it is not visible to `ps`.
async function detach({ owner, session, root, relay, extraEnv }) {
  await ensureStateDir();
  const lf = logFile(owner, session, root);
  const fd = fs.openSync(lf, 'a');
  const args = process.argv.slice(2).filter((a) => a !== '--detach' && a !== '-d');
  const { cmd, args: full } = selfCommand(args);

  const child = spawn(cmd, full, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...extraEnv, TRACKER_DETACHED: '1' },
  });
  child.unref();
  fs.closeSync(fd);

  await writeSession({ owner, session, root, relay, pid: child.pid, startedAt: Date.now(), log: lf });

  console.log(`\u2713 running in the background (pid ${child.pid})`);
  console.log(`  logs:  tracker logs ${owner}/${session}`);
  console.log(`  stop:  tracker stop ${owner}/${session}`);
}

const isDetachedChild = () => process.env.TRACKER_DETACHED === '1';

// A room id can match more than one local session (share + join of the same room,
// or the same room synced into two roots), so this returns every match and lets
// callers decide rather than silently picking one.
function findSessions(target, { root } = {}) {
  const all = listSessions();
  let matches;
  if (target) {
    const [owner, session] = String(target).split('/');
    matches = all.filter((x) => x.owner === owner && x.session === session);
    if (!matches.length) die(`no such session: ${target}`);
  } else {
    matches = all.filter((x) => x.running);
    if (!matches.length) die('no sessions are running');
  }
  if (root) matches = matches.filter((x) => x.root === path.resolve(root));
  return matches;
}


// -- guards -----------------------------------------------------------------
//
// These exist because the defaults were dangerous: --root fell back to the
// current directory, so `tracker join <invite>` typed in the wrong place synced
// an entire home directory, in both directions, with no confirmation.

const KNOWN_FLAGS = {
  login: ['relay', 'forgejo-token', 'dev'],
  logout: [],
  whoami: [],
  version: [],
  status: [],
  stop: ['all', 'root'],
  logs: ['root', 'n', 'follow', 'f'],
  share: ['relay', 'session', 'allow', 'name', 'detach', 'd', 'yes', 'force'],
  join: ['relay', 'root', 'name', 'detach', 'd', 'yes', 'force'],
  sync: [],
};

// An unknown flag used to be collected and ignored, so an old binary meeting a
// new flag silently did something else entirely.
function rejectUnknownFlags(cmd, flags) {
  const known = KNOWN_FLAGS[cmd];
  if (!known) return;
  for (const f of Object.keys(flags)) {
    if (!known.includes(f)) {
      die(`unknown flag --${f} for "${cmd}". Known: ${known.map((k) => `--${k}`).join(', ') || 'none'}`);
    }
  }
}

// Roots that are never a project, and where syncing would expose personal files
// or a whole machine.
function assertSafeRoot(root) {
  const abs = path.resolve(root);
  const home = os.homedir();
  const fsRoot = path.parse(abs).root;

  if (abs === fsRoot) die(`refusing to sync the filesystem root (${abs})`);
  if (abs === home) {
    die(
      `refusing to sync your home directory (${abs}).\n` +
        '  Point --root at the project you mean:  --root=~/path/to/project',
    );
  }
  // root is an ancestor of home: /Users, /home, /Users/you/.. and so on
  if (home.startsWith(abs + path.sep)) {
    die(`refusing to sync ${abs} — it contains your home directory`);
  }
  for (const bad of ['/Users', '/home', '/Volumes', '/etc', '/var', '/usr', '/System', '/Library']) {
    if (abs === bad) die(`refusing to sync ${abs}`);
  }
  if (!fs.existsSync(abs)) die(`no such directory: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) die(`not a directory: ${abs}`);
  return abs;
}

const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(d.trim().toLowerCase()));
    process.stdin.resume();
  });
}

// Show exactly what is about to sync, and make the user agree to anything that
// looks like a mistake. Skipped in the detached child — the parent already asked.
const BIG_SESSION = 1000;

async function preflight(cfg, flags) {
  if (isDetachedChild()) return;
  const scan = await previewScan(cfg);

  console.log(`  ${scan.count} files (${fmtBytes(scan.bytes)}) from ${cfg.root}`);
  console.log(
    scan.gitAware
      ? '  respecting .gitignore'
      : '  not a git repo — using the built-in exclude list only',
  );
  if (scan.byTop.length) {
    const top = scan.byTop.map(([name, n]) => `${name} (${n})`).join(', ');
    console.log(`  top level: ${top}`);
  }
  console.log('');

  if (scan.count === 0) {
    die('nothing to sync here — check --root, or that this project has files matching the include list');
  }
  if (flags.yes || flags.force) return;
  if (scan.count < BIG_SESSION) return;

  if (!process.stdin.isTTY) {
    die(`${scan.count} files is a lot — re-run with --yes if that is really intended`);
  }
  const answer = await ask(`  ${scan.count} files is a lot. Continue? [y/N] `);
  if (answer !== 'y' && answer !== 'yes') {
    console.log('  aborted');
    process.exit(1);
  }
  process.stdin.pause();
}

function requireRelay(relay) {
  if (relay) return relay;
  die(
    'this build has no default relay.\n' +
      '  Pass --relay=wss://<host> on first login; it is remembered afterwards.\n' +
      `  See ${channel.docs}`,
  );
}

// -- commands ---------------------------------------------------------------

async function cmdLogin(flags) {
  const relay = requireRelay(relayFor(flags, null));

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

function cmdVersion() {
  console.log(`tracker ${VERSION} (${channelName} build)`);
  console.log(`relay:     ${DEFAULT_RELAY || '(none — pass --relay)'}`);
  console.log(`downloads: ${channel.downloads}`);
  console.log(`docs:      ${channel.docs}`);
}

function cmdWhoami() {
  const auth = loadAuth();
  if (!auth?.username) die('not logged in');
  console.log(auth.username);
}

function cmdStatus() {
  const auth = loadAuth();
  console.log(`build:     ${VERSION} (${channelName})`);
  console.log(`logged in: ${auth?.username ? `yes (${auth.username})` : 'no'}`);
  console.log(`relay:     ${auth?.relay || DEFAULT_RELAY}`);
  console.log(`config:    ${fs.existsSync('pf-sync.config.json') ? 'pf-sync.config.json' : 'none'}`);

  const sessions = listSessions();
  if (!sessions.length) {
    console.log('sessions:  none (start one with: tracker share <path> --detach)');
    return;
  }
  console.log('sessions:');
  for (const x of sessions) {
    const mins = Math.round((Date.now() - x.startedAt) / 60000);
    const mark = x.running ? '●' : '○';
    const state = x.running ? `running, pid ${x.pid}, up ${mins}m` : 'not running (stale)';
    console.log(`  ${mark} ${x.owner}/${x.session}  ${state}`);
    console.log(`      root ${x.root}`);
  }
  console.log('');
  console.log('Peer and sync detail lives in each session log: tracker logs <owner/session>');
}

async function cmdStop(flags, positional) {
  const all = listSessions();
  if (flags.all) {
    if (!all.length) return console.log('nothing to stop');
    for (const x of all) console.log(`${x.owner}/${x.session}: ${await stopSession(x)}`);
    return;
  }
  // Stop every local session matching the room, or orphans get left behind.
  for (const entry of findSessions(positional[0], { root: flags.root })) {
    console.log(`${entry.owner}/${entry.session} [${entry.root}]: ${await stopSession(entry)}`);
  }
}

function cmdLogs(flags, positional) {
  const matches = findSessions(positional[0], { root: flags.root });
  if (matches.length > 1) {
    console.error('several local sessions match — add --root=<path>:');
    for (const m of matches) console.error(`  ${m.owner}/${m.session}  root ${m.root}`);
    process.exit(1);
  }
  const entry = matches[0];
  if (!entry.log || !fs.existsSync(entry.log)) die(`no log file for ${entry.owner}/${entry.session}`);
  const lines = fs.readFileSync(entry.log, 'utf8').split('\n');
  const n = Number(flags.n || 40);
  console.log(lines.slice(-n - 1).join('\n').trimEnd());
  if (!flags.follow && !flags.f) {
    console.log(`\n(${entry.log} — use tail -f on that path to follow)`);
  }
}

async function cmdShare(flags, positional) {
  const auth = requireAuth();
  const root = assertSafeRoot(positional[0] || process.cwd());

  const session = String(flags.session || path.basename(path.resolve(root))).toLowerCase();
  if (!NAME_RE.test(session)) {
    die(`invalid session name: ${session} (use a-z, 0-9, -, max 39 chars)`);
  }

  // A detached child inherits the parent's key through the environment so the
  // invite stays stable and never appears in argv.
  const roomKey = process.env.TRACKER_ROOM_KEY
    ? fromBase64Url(process.env.TRACKER_ROOM_KEY)
    : generateRoomKey();
  const invite = `${auth.username}/${session}#${toBase64Url(roomKey)}`;
  const relay = relayFor(flags, auth);
  const allow = flags.allow ? String(flags.allow).split(',').filter(Boolean) : null;

  if (!isDetachedChild()) {
    console.log(`✓ session: ${auth.username}/${session}`);
    console.log('');
    console.log(`  invite:  tracker join ${invite}`);
    console.log('');
    console.log('  The part after # is the encryption key. It never reaches the relay,');
    console.log('  and anyone holding it can read and write this session — share it');
    console.log('  over a channel you trust.');
    if (allow) console.log(`  joins restricted to: ${allow.join(', ')}`);
    console.log('');
  }

  const shareCfg = { ...syncDefaults(flags, root), mode: 'e2e' };
  // Before detaching, not after: the detached child skips preflight (the parent
  // is meant to have asked), so running it after the detach branch meant
  // background sessions were never checked at all.
  await preflight(shareCfg, flags);

  if (flags.detach && !isDetachedChild()) {
    return detach({
      owner: auth.username,
      session,
      root: path.resolve(root),
      relay,
      extraEnv: { TRACKER_ROOM_KEY: toBase64Url(roomKey) },
    });
  }

  await runSync({
    ...shareCfg,
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

  // No cwd fallback. Defaulting a *joiner* to the current directory is how an
  // entire home folder got synced: the joining side adopts the shared copy, so
  // getting this wrong overwrites local files and uploads everything else.
  if (!flags.root && !positional[1]) {
    die(
      'join requires --root=<path> — the local directory to sync into.\n' +
        '  e.g. tracker join <invite> --root=~/Projects/myapp',
    );
  }
  const root = assertSafeRoot(flags.root || positional[1]);

  const joinCfg = { ...syncDefaults(flags, root), mode: 'e2e' };
  await preflight(joinCfg, flags);

  if (flags.detach && !isDetachedChild()) {
    return detach({ owner, session, root: path.resolve(root), relay: relayFor(flags, auth) });
  }

  await runSync({
    ...joinCfg,
    relay: requireRelay(relayFor(flags, auth)),
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
      --detach                         run in the background, free the terminal

  tracker join <owner/session#key>     attach to an existing session
      --root=<path>                    local directory to sync (required)
      --detach                         run in the background, free the terminal

  tracker version                      print version, build channel and relay

  tracker stop [owner/session]         stop a background session (--all for every one)
  tracker logs [owner/session]         show a background session's log (-n=<lines>)

  tracker sync -- [legacy flags]       self-hosted shared-secret relay

  Common: --relay=<wss://...>
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (cmd && KNOWN_FLAGS[cmd]) rejectUnknownFlags(cmd, flags);

  switch (cmd) {
    case 'login':
      return cmdLogin(flags);
    case 'logout':
      return cmdLogout();
    case 'whoami':
      return cmdWhoami();
    case 'version':
    case '--version':
    case '-v':
      return cmdVersion();
    case 'status':
      return cmdStatus();
    case 'stop':
      return cmdStop(flags, positional);
    case 'logs':
      return cmdLogs(flags, positional);
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
