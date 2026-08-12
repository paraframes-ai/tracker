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
 │ (Yjs+fs) │  write-back    (encrypted updates)       │ (Yjs+fs) │
 └──────────┘                                           └──────────┘
```

Each side runs a **daemon** that watches the project folder, mirrors file
changes into a shared CRDT document, and writes merged changes from the other
side back to disk. A **relay** in the middle forwards CRDT updates between
peers. It stores nothing, and with the default transport it cannot read what it
forwards — updates are encrypted end-to-end with a key that only the
participants hold.

## What syncs (and what doesn't)

- ✅ Source text: `.swift`, `.h/.m/.mm/.c/.cpp`, `.json`, `.md`, `.strings`,
  `.metal`, `.entitlements`, … (configurable).
- 🚫 **`project.pbxproj`, build output, `DerivedData`, images, binaries** — left
  to git on purpose. Char-level merging would corrupt structured/binary files.
  When you add a file/target in Xcode, commit the `.pbxproj` through git as usual.

Line endings are normalized: the shared document holds LF, and each machine keeps
whatever convention its own files use. Mixed macOS/Windows sessions work without
either side configuring an editor.

## Setup

```bash
tracker login
tracker share ~/Projects/ParaFrames
```

`share` prints an invite:

```
✓ session: ashwin/paraframes

  invite:  tracker join ashwin/paraframes#kR7fJ2mQ8vN3xP1wL5tY9bC4dF6hJ0aS2eG7uI8oK3M
```

Your coworker runs that line with their own checkout:

```bash
tracker join ashwin/paraframes#kR7fJ2mQ... --root ~/dev/ParaFrames
```

Now edit in Xcode as normal. Saved changes appear in your coworker's checkout
within a moment, and vice-versa — including simultaneous edits to the same file.

**The part after `#` is the encryption key.** It never reaches the relay, and
anyone holding it can read and write the session — treat the whole invite as a
secret and send it over a channel you trust. `--allow=<user,...>` on `share`
additionally restricts joins to named accounts.

### Commands

```
tracker login [--dev=<username>]     authenticate (GitHub device flow)
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
```

## From source

Requires Node.js ≥ 20 (WebCrypto is used for encryption).

```bash
npm install
node src/cli.js login
```

## Configuration

`include` / `exclude` globs can be overridden in `pf-sync.config.json` — copy
`pf-sync.config.example.json` to start. `--root` and `--name` are per-machine.

For the legacy self-hosted transport, `relay`, `room`, and `token` **must match**
between participants. Precedence: CLI flags → env (`PF_RELAY`, `PF_ROOM`,
`PF_ROOT`, `PF_NAME`, `PF_TOKEN`) → `pf-sync.config.json` → defaults.

## Self-hosting

You don't need to run a server to use this. If you'd rather not route even
ciphertext through someone else's machine, see
**[docs/self-hosting.md](docs/self-hosting.md)** — it covers both the
authenticated end-to-end relay and the original shared-secret relay (including
the Tailscale + MagicDNS recipe for a GCE e2-small).

The design is written up in
**[RFC 001](docs/rfc-001-hosted-relay.md)** — protocol, auth flow, invite
format, threat model, and quotas.

## Safety notes / current limitations

- **Baseline rule:** start from the same clean git commit. If your local copy of
  a file differs from the shared copy when you connect, the shared copy wins and
  your local version is saved to `.pf-sync-trash/` (nothing is silently lost).
- **Deletes** from your coworker move your local file to `.pf-sync-trash/` rather
  than hard-deleting.
- The relay keeps the session in memory only. If **all** daemons disconnect, the
  shared doc is gone and the next one to connect re-seeds it from its disk —
  which is why git remains your durable source of truth. (Persistent rooms are on
  the roadmap, and remain compatible with end-to-end encryption: the relay would
  retain ciphertext it still cannot read.)
- **Metadata is not encrypted.** The relay operator can see usernames, session
  names, peer counts, message sizes, and timing — just not file contents or
  names.
- **No forward secrecy** yet: whoever holds a room key can read that session's
  traffic. Rotating means issuing a new invite.

## Roadmap

- Presence in Xcode (collaborator cursors) via a Source Editor extension.
- Persistent relay rooms so sessions survive full disconnects.
- Forward secrecy via per-session key agreement between peers.
- A menu-bar app wrapper so non-terminal users can start/stop a session.
