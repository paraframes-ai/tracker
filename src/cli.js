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
import { CLI_CLIENT_ID, accountsUrlFor, channel, channelName } from './channel.js';
import { browserLogin } from './oauth.js';
import { roomKeyFor } from './room-keys.js';
import { PROFILE_IDS, applySettings, detectIdes, profileById } from './ide.js';
import { execFile } from 'node:child_process';
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
const VERSION = '0.1.5';

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
  clientVersion: VERSION,
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
  login: ['relay', 'forgejo-token', 'dev', 'git-host'],
  '': ['relay','session','allow','name','yes','force','new-key','ide','no-autosave'],
  logout: [],
  whoami: [],
  version: [],
  status: [],
  stop: ['all', 'root'],
  logs: ['root', 'n', 'follow', 'f'],
  share: ['relay','session','allow','name','detach','d','yes','force','new-key','ide','no-autosave'],
  join: ['relay','root','name','detach','d','yes','force','ide','no-autosave'],
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

async function preflight(cfg, flags, { allowEmpty = false } = {}) {
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
    // Empty is the normal case when joining: you join precisely to receive the
    // other side's files. Only a *share* of nothing is a mistake.
    if (!allowEmpty) {
      die('nothing to sync here — check --root, or that this project has files matching the include list');
    }
    console.log('  (empty — files will arrive from the session)');
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


// Apply an IDE profile: editor-specific excludes, any settings the editor
// actually supports, and honest guidance where it supports none. Entirely
// optional — sync works with any editor because it happens at the filesystem.
async function applyIdeProfile(root, flags) {
  const requested = flags.ide;
  if (requested === 'none') return { profiles: [], extraExclude: [] };

  let profiles;
  if (requested && requested !== true) {
    const p = profileById(String(requested));
    if (!p) die(`unknown --ide=${requested}. Known: ${PROFILE_IDS.join(', ')}, none`);
    profiles = [p];
  } else {
    profiles = detectIdes(root);
  }
  if (!profiles.length) return { profiles: [], extraExclude: [] };

  const extraExclude = profiles.flatMap((p) => p.exclude);
  // At most one editor needs driving; if a repo matches two, the one that
  // declares an autosave mechanism wins.
  const autosave = flags['no-autosave'] ? null : (profiles.find((p) => p.autosave)?.autosave ?? null);
  for (const p of profiles) {
    console.log(`  ${p.label}`);
    if (p.settings && requested) {
      // Only written when the IDE was named explicitly — silently editing a
      // project's editor settings on autodetect would be presumptuous.
      const applied = await applySettings(root, p).catch(() => null);
      if (applied?.changed?.length) {
        console.log(`    wrote ${applied.changed.join(', ')} to ${p.settings.file}`);
      }
    } else if (p.settings) {
      console.log(`    tip: --ide=${p.id} also enables autosave for near-instant sync`);
    }
    if (p.autosave && flags['no-autosave']) {
      console.log('    autosave disabled (--no-autosave); changes propagate when you save');
    } else {
      for (const note of p.notes) console.log(`    ${note}`);
    }
  }
  return { profiles, extraExclude, autosave };
}

function copyToClipboard(text) {
  const cmd = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : 'xclip';
  const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, () => resolve(false));
      child.on('error', () => resolve(false));
      child.stdin.end(text, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
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
  // Default: sign in through the browser against the git host. Nothing to paste;
  // the user is usually already signed in there, so it is one click.
  const gitHost = flags['git-host'] || channel.gitHost;
  if (!gitHost) die('no git host configured for this build — use --git-host=<url>');

  const forgejoToken = await browserLogin({
    forgejoUrl: gitHost,
    clientId: CLI_CLIENT_ID,
    onPrompt: (url) => {
      console.log('→ opening your browser to sign in…');
      console.log(`  if it did not open, visit:\n  ${url}`);
    },
  });
  const out = await forgejoLogin({ relay, forgejoToken });
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

async function cmdStatus() {
  const auth = loadAuth();
  console.log(`build:     ${VERSION} (${channelName})`);
  console.log(`logged in: ${auth?.username ? `yes (${auth.username})` : 'no'}`);
  console.log(`relay:     ${auth?.relay || DEFAULT_RELAY}`);

  const sessions = listSessions();
  if (sessions.length) {
    console.log('local:');
    for (const x of sessions) {
      const mins = Math.round((Date.now() - x.startedAt) / 60000);
      console.log(
        `  ${x.running ? '●' : '○'} ${x.owner}/${x.session}  ` +
          `${x.running ? `running, pid ${x.pid}, up ${mins}m` : 'not running (stale)'}`,
      );
      console.log(`      root ${x.root}`);
    }
  } else {
    console.log('local:     no sessions (start one with: tracker share <path>)');
  }

  // The local pid says a process exists; it cannot say whether anything is
  // actually syncing. Ask the relay — that is the question people actually have,
  // and answering it previously meant reading server logs.
  if (!auth?.token) return;
  let live = null;
  try {
    const httpBase = (auth.relay || DEFAULT_RELAY).replace(/^ws/, 'http').replace(/\/+$/, '');
    const res = await fetch(`${httpBase}/v1/sessions`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) live = await res.json();
  } catch {
    console.log('relay:     unreachable — cannot show live peers');
    return;
  }
  if (!live) return;

  console.log('');
  if (!live.sessions.length) {
    console.log('relay:     no live sessions for this account');
    return;
  }
  console.log('live on the relay:');
  for (const sess of live.sessions) {
    console.log(`  ${sess.id}   ${sess.peerCount} peer${sess.peerCount === 1 ? '' : 's'}`);
    for (const p of sess.peers) {
      const idle = Math.round((live.now - p.lastActiveAt) / 1000);
      console.log(
        `      ${p.username.padEnd(20)} up ${fmtBytes(p.bytesIn)}  down ${fmtBytes(p.bytesOut)}` +
          `   active ${idle}s ago`,
      );
    }
    // The failure that is hardest to notice: connected, but to a session nobody
    // else joined. Everything looks healthy and nothing syncs.
    if (sess.peerCount === 1) {
      const alone = Math.round((live.now - sess.peers[0].joinedAt) / 60000);
      if (alone >= 2) {
        console.log(
          `      ⚠  alone here for ${alone}m — is your collaborator using this exact invite?`,
        );
      }
    }
  }
  if (live.refusals?.length) {
    const recent = live.refusals[live.refusals.length - 1];
    console.log(`  ⚠  last refusal: ${recent.username} ${recent.code} ${recent.reason}`);
  }
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

  // The key persists per project, so restarting a session — or the relay, or the
  // laptop — keeps the same invite. Regenerating it every run meant a new
  // sixty-character string had to be sent to the collaborator each time.
  let roomKey;
  let reusedKey = false;
  if (process.env.TRACKER_ROOM_KEY) {
    roomKey = fromBase64Url(process.env.TRACKER_ROOM_KEY);
    reusedKey = true;
  } else {
    const got = await roomKeyFor(auth.username, session, path.resolve(root), {
      rotate: Boolean(flags['new-key']),
    });
    roomKey = got.key;
    reusedKey = got.reused;
  }
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
    if (reusedKey) {
      console.log('  (same invite as last time — it stays valid across restarts)');
    } else if (flags['new-key']) {
      console.log('  (new key — any previously shared invite no longer works)');
    }
    if (allow) console.log(`  joins restricted to: ${allow.join(', ')}`);
    console.log('');
  }

  const ide = await applyIdeProfile(root, flags);
  const shareCfg = { ...syncDefaults(flags, root), mode: 'e2e' };
  shareCfg.exclude = [...shareCfg.exclude, ...ide.extraExclude];
  shareCfg.autosave = ide.autosave;
  // Before detaching, not after: the detached child skips preflight (the parent
  // is meant to have asked), so running it after the detach branch meant
  // background sessions were never checked at all.
  await preflight(shareCfg, flags);

  if (!isDetachedChild()) {
    const copied = await copyToClipboard(`tracker join ${invite}`);
    if (copied) console.log('  (invite copied to your clipboard)');
  }

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

  const ide = await applyIdeProfile(root, flags);
  const joinCfg = { ...syncDefaults(flags, root), mode: 'e2e' };
  joinCfg.exclude = [...joinCfg.exclude, ...ide.extraExclude];
  joinCfg.autosave = ide.autosave;
  await preflight(joinCfg, flags, { allowEmpty: true });

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

// `tracker` with no arguments, run inside a project: the shortest path from
// nothing to a live session. Signs in if needed, shares the current directory in
// the background, and puts the invite on the clipboard.
async function cmdDefault(flags) {
  if (!fs.existsSync(path.join(process.cwd(), '.git')) && !flags.force) {
    console.log('This does not look like a project directory (no .git here).');
    console.log('Run it inside your project, or name one:  tracker share <path>');
    return usage();
  }
  if (!loadAuth()?.token) {
    console.log('Not signed in yet — opening your browser…\n');
    await cmdLogin({});
    console.log('');
  }
  return cmdShare({ ...flags, detach: true }, []);
}

async function cmdSync() {
  // Unchanged legacy path for self-hosted shared-secret relays.
  const { loadConfig } = await import('./config.js');
  await runSync({ ...loadConfig(), mode: 'legacy' });
}

function usage() {
  console.log(`tracker — real-time collaborative file sync

  tracker login                        sign in via your browser (no token needed)
      --git-host=<url>                 git host to authenticate against
      --forgejo-token[=<t>]            headless: use an access token instead
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
      --new-key                        rotate the invite key for this project
      --ide=<name|none>                xcode | vscode | visualstudio | jetbrains
      --no-autosave                    do not drive the editor to save

  tracker join <owner/session#key>     attach to an existing session
      --root=<path>                    local directory to sync (required)
      --detach                         run in the background, free the terminal

  tracker                              in a project: sign in, share, copy invite
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
  rejectUnknownFlags(cmd ?? '', flags);

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
      return usage();
    case undefined:
      return cmdDefault(flags);
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
