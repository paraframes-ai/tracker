# ParaFrames Live

Real-time collaborative editing for the **ParaFrames** SwiftUI app — so you and
your coworker can see each other's edits live while **both keep using Xcode**.

It is **not** a replacement for git. It's a thin real-time layer that runs
*alongside* git:

| Concern | Tool |
| --- | --- |
| "Edit together right now, see each other's keystrokes merge" | **ParaFrames Live** (this) |
| Permanent history, branches, PRs, releases, code review | **git / GitHub** |

## Why not just git?

Git is snapshot-and-merge: it's built for *asynchronous* work with *manual*
conflict resolution. It will never feel real-time. Live collaboration needs a
different data model — a **CRDT** (Conflict-free Replicated Data Type), where
two people can edit the same line at the same time and the results converge
automatically, with no conflict prompt. That's what Google Docs and Figma use,
and it's what this uses ([Yjs](https://github.com/yjs/yjs)).

You keep committing and pushing to GitHub exactly as before. This just handles
the "we're both in the file at the same time" moment in between commits.

## How it works

```
  You (Xcode)                                          Coworker (Xcode)
      │ save .swift                                          │ save .swift
      ▼                                                      ▼
 ┌──────────┐   fs watch          relay (WebSocket)    ┌──────────┐
 │  daemon  │◀────────────▶ CRDT ◀────────────────────▶│  daemon  │
 │ (Yjs+fs) │  write-back       (Yjs updates)          │ (Yjs+fs) │
 └──────────┘                                           └──────────┘
```

Each side runs a **daemon** that watches the project folder, mirrors file
changes into a shared CRDT document, and writes merged changes from the other
side back to disk. A small **relay** in the middle just forwards CRDT updates
(it stores nothing and never sees your files as files).

## What syncs (and what doesn't)

- ✅ Source text: `.swift`, `.h/.m/.mm/.c/.cpp`, `.json`, `.md`, `.strings`,
  `.metal`, `.entitlements`, … (configurable).
- 🚫 **`project.pbxproj`, build output, `DerivedData`, images, binaries** — left
  to git on purpose. Char-level merging would corrupt structured/binary files.
  When you add a file/target in Xcode, commit the `.pbxproj` through git as usual.

## Setup

Requires Node.js ≥ 18.

```bash
npm install
```

### 1. Run the relay (once, somewhere both of you can reach)

For real internet use, run this on a small server behind TLS and set a shared
secret:

```bash
PF_RELAY_TOKEN=some-shared-secret npm run relay
# listens on ws://0.0.0.0:1234  (put a TLS proxy in front for wss://)
```

Cheap options: a $5 VPS, Fly.io, Render, or your own machine exposed via a
tunnel (Tailscale / cloudflared / ngrok).

### 2. Each developer runs a daemon

Get on the **same git commit with a clean tree first** (`git pull`), then:

```bash
cp pf-sync.config.example.json pf-sync.config.json
# edit relay/room/token (must match your coworker) and your local root/name
npm run sync
```

Or without a config file, via flags/env:

```bash
npm run sync -- \
  --relay=wss://your-host \
  --room=paraframes \
  --token=some-shared-secret \
  --root=/Users/you/dev/ParaFrames \
  --name=alex
```

Now edit in Xcode as normal. Saved changes appear in your coworker's checkout
within a moment, and vice-versa — including simultaneous edits to the same file.

## Configuration

`relay`, `room`, and `token` **must match** between the two of you. `root` and
`name` are per-machine. Precedence: CLI flags → env (`PF_RELAY`, `PF_ROOM`,
`PF_ROOT`, `PF_NAME`, `PF_TOKEN`) → `pf-sync.config.json` → defaults. `include`
/ `exclude` globs can be overridden in the config file.

## Safety notes / current limitations (MVP)

- **Baseline rule:** start from the same clean git commit. If your local copy of
  a file differs from the shared copy when you connect, the shared copy wins and
  your local version is saved to `.pf-sync-trash/` (nothing is silently lost).
- **Deletes** from your coworker move your local file to `.pf-sync-trash/` rather
  than hard-deleting.
- The relay keeps the session in memory only. If **both** daemons disconnect,
  the shared doc is gone and the next one to connect re-seeds it from its disk —
  which is why git remains your durable source of truth. (Persistent rooms are on
  the roadmap.)
- Best on trusted networks or behind TLS + token. Treat the token as a secret.

## Roadmap

- Presence in Xcode (collaborator cursors) via a Source Editor extension.
- Persistent relay rooms (LevelDB) so sessions survive full disconnects.
- End-to-end encryption of CRDT updates so the relay never sees plaintext.
- A menu-bar app wrapper so non-terminal users can start/stop a session.
