// Loads sync configuration from (in order of precedence):
//   1. CLI flags       --relay=... --room=... --root=... --name=... --token=...
//   2. Environment     PF_RELAY, PF_ROOM, PF_ROOT, PF_NAME, PF_TOKEN
//   3. pf-sync.config.json in the current directory
//   4. Built-in defaults
//
// Both developers MUST use the same `relay`, `room`, and `token`. Everything
// else (root path, display name) is per-machine.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Only these files are synced in real time. Everything else (project.pbxproj,
// build output, images, ...) is left to git — char-level CRDT merging would
// corrupt structured/binary files.
// What syncs, by default.
//
// Two principles, so this works for any stack rather than the one it was written
// for:
//
//  1. Include source *text* broadly. Character-level CRDT merging is safe for
//     text and corrupts anything structured or binary.
//  2. Delegate "what is build output" to .gitignore. Every project already
//     declares that, correctly, for its own toolchain — Unity's Library/, Node's
//     node_modules/, Python's __pycache__/, Rust's target/. Enumerating them here
//     would mean guessing at ecosystems we have never seen, and getting it wrong
//     both ways: syncing junk, or excluding a directory a project legitimately
//     uses. See gitCandidates() in daemon.js.
export const DEFAULT_INCLUDE = [
  // systems / compiled
  '**/*.swift', '**/*.h', '**/*.hpp', '**/*.hh', '**/*.m', '**/*.mm',
  '**/*.c', '**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.cs', '**/*.java',
  '**/*.kt', '**/*.kts', '**/*.go', '**/*.rs', '**/*.scala', '**/*.dart',
  '**/*.zig', '**/*.hs', '**/*.ml', '**/*.ex', '**/*.exs', '**/*.erl',
  '**/*.clj', '**/*.cljs', '**/*.lua', '**/*.r', '**/*.jl',
  // scripting / web
  '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx',
  '**/*.vue', '**/*.svelte', '**/*.py', '**/*.rb', '**/*.php', '**/*.pl',
  '**/*.sh', '**/*.bash', '**/*.zsh', '**/*.fish', '**/*.ps1',
  '**/*.html', '**/*.htm', '**/*.css', '**/*.scss', '**/*.sass', '**/*.less',
  // data / config / docs
  '**/*.json', '**/*.jsonc', '**/*.yaml', '**/*.yml', '**/*.toml',
  '**/*.ini', '**/*.cfg', '**/*.conf', '**/*.xml', '**/*.csv', '**/*.tsv',
  '**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', '**/*.adoc',
  '**/*.sql', '**/*.graphql', '**/*.gql', '**/*.proto',
  '**/*.tf', '**/*.hcl', '**/*.gradle', '**/*.cmake',
  // apple-specific text formats
  '**/*.strings', '**/*.metal', '**/*.entitlements',
  // common extensionless files
  '**/Makefile', '**/Dockerfile', '**/CMakeLists.txt', '**/.editorconfig',
];

// Deliberately short. Anything a project considers build output is handled by
// .gitignore; this list is only for things no project should ever share live.
export const DEFAULT_EXCLUDE = [
  // version control internals
  '**/.git/**', '**/.hg/**', '**/.svn/**',

  // ours
  '**/.pf-sync-trash/**',

  // OS noise
  '**/.DS_Store', '**/Thumbs.db',

  // Structured files a character-level merge would corrupt. Left to git on
  // purpose — see the README.
  '**/project.pbxproj',
  '**/*.xcuserstate',

  // Credentials. Excluded even when a project tracks them, because live-syncing
  // a secret to a collaborator is worse than the inconvenience of it not syncing.
  '**/.ssh/**', '**/.aws/**', '**/.gnupg/**', '**/.netrc',
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.keystore',
  '**/.config/**', '**/.npmrc', '**/.pypirc', '**/.docker/**',

  // Agent and editor state directories. Delegating to .gitignore is right for
  // build output and wrong for these: they routinely hold API tokens and are
  // routinely *not* gitignored, so git offers them up as ordinary project files.
  // Observed in practice — a peer with a mis-set root replicated .gemini/ and
  // .copilot/ into a collaborator's checkout twice.
  //
  // .claude/ also holds worktrees: whole duplicate checkouts that would sync as
  // if they were real files.
  '**/.claude/**', '**/.gemini/**', '**/.copilot/**', '**/.cursor/**',
  '**/.codeium/**', '**/.continue/**', '**/.aider*',
];

function parseCliFlags(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const cli = parseCliFlags(argv);

  let fileCfg = {};
  const cfgPath = path.resolve(process.cwd(), 'pf-sync.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${cfgPath}: ${err.message}`);
    }
  }

  const pick = (key, envKey, fallback) =>
    cli[key] ?? process.env[envKey] ?? fileCfg[key] ?? fallback;

  const config = {
    relay: pick('relay', 'PF_RELAY', 'ws://localhost:1234'),
    room: pick('room', 'PF_ROOM', 'paraframes'),
    root: path.resolve(pick('root', 'PF_ROOT', process.cwd())),
    name: pick('name', 'PF_NAME', os.userInfo().username || 'anon'),
    token: pick('token', 'PF_TOKEN', ''),
    include: fileCfg.include ?? DEFAULT_INCLUDE,
    exclude: fileCfg.exclude ?? DEFAULT_EXCLUDE,
  };

  if (!fs.existsSync(config.root)) {
    throw new Error(`Sync root does not exist: ${config.root}`);
  }

  return config;
}
