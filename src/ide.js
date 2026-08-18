// IDE profiles.
//
// Optional, always. The defaults work with any editor, because sync happens at
// the filesystem — a profile only smooths the edges of a *particular* editor:
// which of its scratch files should never sync, and, where the editor allows it,
// making it write to disk promptly so changes actually propagate.
//
// Be honest about what each can do, because the mechanism differs per editor:
//
//   VS Code family  a real autosave setting, written into .vscode/settings.json
//   JetBrains       already autosaves; nothing to do but exclude its scratch
//   Xcode           no setting exists, so it is driven to save via Apple Events
//   Visual Studio   writes on build and focus change; no per-project setting
//
// Claiming uniform "IDE support" would be a lie each user discovers within a
// minute of trying it, so each profile states its own mechanism and limits.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// VS Code and every fork that keeps its settings format: Cursor, Windsurf,
// Antigravity, VSCodium, Trae. Detection is by the .vscode directory they all
// read, so forks work without being enumerated.
const VSCODE_FAMILY = {
  id: 'vscode',
  label: 'VS Code (and forks: Cursor, Windsurf, Antigravity, VSCodium)',
  detect: (root) =>
    ['.vscode', '.cursor', '.windsurf', '.antigravity', '.trae', '.zed'].some((d) =>
      fs.existsSync(path.join(root, d)),
    ),
  exclude: [
    '**/.vscode/**',
    '**/.cursor/**',
    '**/.windsurf/**',
    '**/.antigravity/**',
    '**/.history/**',
  ],
  // The setting that matters: without it the editor holds the buffer and nothing
  // propagates until a manual save.
  settings: {
    file: '.vscode/settings.json',
    values: {
      'files.autoSave': 'afterDelay',
      'files.autoSaveDelay': 500,
    },
  },
  notes: [
    'Autosave every 500ms is written to .vscode/settings.json, so edits propagate',
    'within about a second without saving by hand.',
  ],
};

const XCODE = {
  id: 'xcode',
  label: 'Xcode',
  detect: (root) =>
    fs.readdirSync(root, { withFileTypes: true }).some(
      (e) => e.isDirectory() && (e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')),
    ),
  exclude: [
    '**/xcuserdata/**',
    '**/*.xcuserstate',
    '**/DerivedData/**',
    '**/*.xcscmblueprint',
    '**/*.xccheckout',
    '**/.swiftpm/**',
    '**/Package.resolved',
  ],
  // Xcode has no autosave preference, so there is nothing to write into a
  // settings file. Instead it is driven to save via its own scripting
  // dictionary — see src/autosave.js for why Apple Events rather than
  // synthetic keystrokes.
  settings: null,
  autosave: 'xcode',
  notes: [
    'Xcode has no autosave setting, so tracker asks it to save every 2s instead.',
    'macOS will prompt once to allow controlling Xcode (Automation, not',
    'Accessibility — it authorises this one pairing, not control of your machine).',
    'Decline it and everything still works; changes then propagate on ⌘S or a build.',
    'Disable with --no-autosave.',
  ],
};

const VISUAL_STUDIO = {
  id: 'visualstudio',
  label: 'Visual Studio',
  detect: (root) =>
    fs.readdirSync(root).some((n) => n.endsWith('.sln')) ||
    fs.existsSync(path.join(root, '.vs')),
  exclude: ['**/.vs/**', '**/bin/**', '**/obj/**', '**/*.user', '**/*.suo', '**/packages/**'],
  settings: null, // no user-settable autosave-on-idle
  notes: [
    'Visual Studio writes files on build and on focus change, not continuously,',
    'so changes propagate when you build or switch away from the editor.',
  ],
};

// One profile for the whole family — IntelliJ, Rider, PyCharm, WebStorm, CLion,
// GoLand, PhpStorm, RubyMine, AppCode, Android Studio — since they share the
// .idea project layout and the same save behaviour.
const JETBRAINS = {
  id: 'jetbrains',
  label: 'JetBrains (IntelliJ, Rider, PyCharm, WebStorm, CLion, GoLand, Android Studio)',
  detect: (root) => {
    if (fs.existsSync(path.join(root, '.idea'))) return true;
    try {
      return fs.readdirSync(root).some((n) => n.endsWith('.iml') || n.endsWith('.ipr'));
    } catch {
      return false;
    }
  },
  exclude: [
    // Project metadata: per-developer, and workspace.xml churns constantly.
    '**/.idea/**',
    '**/*.iml',
    '**/*.ipr',
    '**/*.iws',
    // Build output across the JVM/.NET/Android toolchains these IDEs drive.
    '**/out/**',
    '**/.gradle/**',
    '**/build/**',
    '**/target/**',
    '**/bin/Debug/**',
    '**/bin/Release/**',
    '**/obj/Debug/**',
    '**/obj/Release/**',
    '**/.mvn/**',
    // Local Android/Gradle settings that are machine-specific.
    '**/local.properties',
    '**/captures/**',
  ],
  settings: null,
  // JetBrains IDEs already write to disk on their own, so nothing needs driving.
  notes: [
    'JetBrains IDEs autosave, so changes propagate without any setup: they save',
    'after ~15s idle and whenever you switch to another app.',
    'For faster sync, lower Settings → Appearance & Behavior → System Settings →',
    '"Save files if the IDE is idle for N seconds".',
  ],
};

export const PROFILES = [VSCODE_FAMILY, XCODE, VISUAL_STUDIO, JETBRAINS];
export const PROFILE_IDS = PROFILES.map((p) => p.id);

// Best-effort detection. Returns every profile that matches, since a repo can
// legitimately hold an .xcodeproj and a .vscode directory.
export function detectIdes(root) {
  return PROFILES.filter((p) => {
    try {
      return p.detect(root);
    } catch {
      return false;
    }
  });
}

export const profileById = (id) => PROFILES.find((p) => p.id === id) || null;

// Merge our settings into the editor's config without discarding the user's.
export async function applySettings(root, profile) {
  if (!profile?.settings) return null;
  const target = path.join(root, profile.settings.file);
  let existing = {};
  try {
    existing = JSON.parse(await fsp.readFile(target, 'utf8'));
  } catch {
    /* absent or unparseable; we will write a fresh one */
  }
  const changed = Object.entries(profile.settings.values).filter(
    ([k, v]) => existing[k] !== v,
  );
  if (!changed.length) return { path: target, changed: [] };

  const merged = { ...existing, ...profile.settings.values };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(merged, null, 2)}\n`);
  return { path: target, changed: changed.map(([k]) => k) };
}
