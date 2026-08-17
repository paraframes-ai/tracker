// IDE profiles.
//
// Optional, always. The defaults work with any editor, because sync happens at
// the filesystem — a profile only smooths the edges of a *particular* editor:
// which of its scratch files should never sync, and, where the editor allows it,
// making it write to disk promptly so changes actually propagate.
//
// Be honest about what each can do. VS Code and its forks expose an autosave
// setting, so a profile genuinely makes them near-real-time. Xcode does not
// expose one at all, so its profile is excludes plus accurate guidance — dressing
// that up as "Xcode support" would be a lie the user discovers within a minute.

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
    fs.existsSync(path.join(root, '.vscode')) ||
    fs.existsSync(path.join(root, '.cursor')) ||
    fs.existsSync(path.join(root, '.windsurf')),
  exclude: ['**/.vscode/**', '**/.history/**', '**/.idea/**'],
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
  ],
  settings: null, // Xcode has no autosave preference for source files. None.
  notes: [
    'Xcode has no autosave setting, so it writes to disk only on ⌘S or a build.',
    'Your edits reach collaborators when you save; theirs land on disk immediately',
    'but Xcode may keep showing its own buffer until the file is reopened.',
    'Editing a file you have unsaved changes in is safe — overlapping edits are',
    'merged rather than overwritten — but ⌘S often is the smoothest habit.',
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

const JETBRAINS = {
  id: 'jetbrains',
  label: 'JetBrains (Rider, IntelliJ, AppCode)',
  detect: (root) => fs.existsSync(path.join(root, '.idea')),
  exclude: ['**/.idea/**', '**/out/**', '**/*.iml'],
  settings: null, // JetBrains IDEs already autosave aggressively by default
  notes: ['JetBrains IDEs autosave by default, so changes propagate without any setup.'],
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
