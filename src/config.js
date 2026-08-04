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
const DEFAULT_INCLUDE = [
  '**/*.swift',
  '**/*.h',
  '**/*.m',
  '**/*.mm',
  '**/*.c',
  '**/*.cpp',
  '**/*.json',
  '**/*.md',
  '**/*.txt',
  '**/*.strings',
  '**/*.metal',
  '**/*.entitlements',
];

const DEFAULT_EXCLUDE = [
  '**/.git/**',
  '**/DerivedData/**',
  '**/build/**',
  '**/.build/**',
  '**/Pods/**',
  '**/xcuserdata/**',
  '**/*.xcuserstate',
  '**/.DS_Store',
  '**/node_modules/**',
  '**/project.pbxproj', // structured — let git own it
  '**/.pf-sync-trash/**',
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
