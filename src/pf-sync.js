#!/usr/bin/env node
// Legacy entry point — the original flag interface, unchanged:
//
//   pf-sync --relay=... --room=... --token=... --root=... --name=...
//
// This exists as its own file rather than as a guarded auto-run inside
// daemon.js so that importing the daemon never starts one. `tracker sync` is
// the equivalent through the new CLI.

import { loadConfig } from './config.js';
import { runSync } from './daemon.js';

runSync({ ...loadConfig(), mode: 'legacy' }).catch((err) => {
  console.error(err);
  process.exit(1);
});
