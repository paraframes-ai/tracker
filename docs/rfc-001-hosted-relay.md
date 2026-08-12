# RFC 001 — Hosted relay, accounts, and end-to-end encryption

| | |
| --- | --- |
| **Status** | Draft — for review |
| **Supersedes** | The `PF_RELAY_TOKEN` shared-secret model |
| **Depends on** | Nothing; self-hosting remains supported throughout |

## 1. Summary

Today ParaFrames Live requires each pair of collaborators to operate their own
relay and put it on a private network (Tailscale) or behind a tunnel. That is a
reasonable ask for the two of us and an unreasonable one for anyone else.

This RFC proposes:

1. A **hosted relay** so `install → login → share` is the whole setup.
2. **GitHub-backed accounts**, so sessions are addressed as `username/session`
   instead of by a shared secret.
3. **End-to-end encryption**, so the hosted relay never sees source code.

Self-hosting stays a first-class option. Nothing here breaks existing
deployments.

## 2. Goals and non-goals

**Goals**

- No server to run, no tunnel, no certificate management for the common case.
- Human-memorable session addresses (`ashwin/paraframes`).
- The relay operator cannot read participants' code, by construction.
- One static binary per platform, no runtime dependency.
- Self-hosting remains supported and documented.

**Non-goals for v1**

- Forward secrecy. Compromise of a room key exposes that session's traffic.
  Rotation means issuing a new invite.
- Persistent rooms. Sessions stay memory-only (see §11 — persistence is
  compatible with this design, just deferred).
- Non-GitHub identity. Deliberately deferred; §5.5 keeps the door open.
- Hiding metadata. The operator sees usernames, room names, sizes, and timing.
  See §10.

## 3. Terminology

| Term | Meaning |
| --- | --- |
| **Peer** | One running `tracker` process, attached to one room |
| **Room** | A collaboration session, addressed `owner/session` |
| **Owner** | The authenticated user whose namespace holds the room |
| **Room key** | 256-bit symmetric key; encrypts all room content |
| **Invite** | `owner/session#<base64url(room key)>` |
| **Service token** | Short-lived token this service issues after GitHub login |

## 4. Architecture

```
   Peer A (tracker)                                   Peer B (tracker)
        │  fs watch                                        │  fs watch
        ▼                                                  ▼
   ┌─────────┐                                        ┌─────────┐
   │ Yjs doc │                                        │ Yjs doc │
   └────┬────┘                                        └────┬────┘
        │ encrypt(room key)                                │
        ▼                                                  ▼
   ┌────────────────────────── relay ──────────────────────────┐
   │  authenticate → route by room id → fan out opaque bytes   │
   │  never holds the room key; cannot decrypt                 │
   └───────────────────────────────────────────────────────────┘
```

The relay is a router. It authenticates connections, enforces quotas, and
forwards ciphertext to the other peers in the room. It performs no CRDT
operations.

This is a **simplification** of the current server. `src/relay.cjs` presently
calls `y-websocket/bin/utils`'s `setupWSConnection`, which parses the Yjs
protocol server-side — incompatible with ciphertext. Removing it also drops the
`levelup`/`leveldown` dependency chain.

## 5. Identity and authentication

### 5.1 Why GitHub device flow

The client is a CLI with no browser callback and no safe place for a client
secret. GitHub's OAuth **device flow** is designed for exactly this: it needs no
client secret, only a public `client_id`. Usernames come pre-verified and
globally unique, which removes name squatting and recovery entirely.

### 5.2 Login

```
$ tracker login
→ visit https://github.com/login/device and enter CODE-1234
✓ logged in as ashwin
```

1. CLI `POST https://github.com/login/device/code` with `client_id` and
   `scope=` (empty — only public profile is required).
2. CLI shows `user_code` and `verification_uri`; opens a browser if available.
3. CLI polls `POST https://github.com/login/oauth/access_token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, honouring the
   returned `interval` and `slow_down` responses.
4. CLI sends the resulting GitHub token to `POST /v1/auth/exchange` **once**.
5. Relay calls GitHub `GET /user` to resolve `id` and `login`, then discards the
   GitHub token and returns its own **service token**.

The GitHub token is never stored on disk and never reused. Requesting no scopes
means a leaked service token grants access to this service only — it confers no
access to the user's repositories.

### 5.3 Service token

Signed JWT (Ed25519), 30-day expiry:

```json
{ "sub": "gh:1234567", "username": "ashwin", "iat": ..., "exp": ... }
```

Stored at `~/.config/tracker/auth.json`, mode `0600`. `tracker logout` deletes
it. Expiry requires re-running `tracker login`; no refresh tokens in v1.

Presented as `Authorization: Bearer <token>` on the WebSocket upgrade — a header,
not a query parameter, so it stays out of access logs. The CLI controls its own
requests, so the browser limitation on WebSocket headers does not apply.

### 5.4 Namespace authorization

- **Creating** `ashwin/paraframes` requires a token whose `username` is `ashwin`.
  The namespace is self-policing; no reservation system needed.
- **Joining** requires only a valid token plus an existing room. The room key is
  the real capability (§6.2).
- **Optionally** the owner may restrict by username:

  ```
  $ tracker share ~/Projects/paraframes --allow william
  ```

  The relay can enforce this because usernames are authenticated, unlike key
  possession.

### 5.5 Future identity providers

`sub` is namespaced (`gh:`) precisely so OIDC or email identities can be added
later without colliding. Usernames would then need a claim/reservation
mechanism, which is why v1 avoids it.

## 6. Rooms and invites

### 6.1 Addressing

`owner/session` — e.g. `ashwin/paraframes`. `session` defaults to the basename
of `--root`. Both segments: `[a-z0-9][a-z0-9-]{0,38}`, case-insensitive.

### 6.2 Invite format

```
tracker join ashwin/paraframes#kR7fJ2mQ8vN3xP1wL5tY9bC4dF6hJ0aS2eG7uI8oK3M
                               └── base64url(32-byte room key)
```

The fragment is generated client-side by `tracker share` and **never
transmitted to the relay**. Deliberately mirroring the URL-fragment convention:
it signals "secret, not part of the address."

The invite is a **capability**. Anyone holding it can read the session, so it
must travel over a channel the participants trust. `--allow` (§5.4) adds an
authenticated second factor.

Wrong or corrupted keys surface as an authentication failure on the first frame,
reported as `invite key does not match this session` — not as silent
non-syncing.

## 7. Wire protocol

Version lives in the path: `wss://<host>/v1/rooms/<owner>/<session>`.

Binary frames, one-byte type tag:

| Type | Direction | Payload | Relay reads it? |
| --- | --- | --- | --- |
| `0x01` | peer ↔ peer | Encrypted Yjs sync/update | No — opaque |
| `0x02` | peer ↔ peer | Encrypted awareness/presence | No — opaque |
| `0x03` | relay → peer | Control: peer joined/left, errors, quota | Plaintext |
| `0x04` | both | Keepalive ping/pong | Plaintext |

`0x01` and `0x02` are fanned out unmodified to every other peer in the room.
Control frames (`0x03`) are plaintext and intentionally so: presence requires
the relay to name peers, and errors must be legible when decryption is the thing
that is broken.

## 8. Cryptography

| Property | Choice |
| --- | --- |
| Cipher | AES-256-GCM via WebCrypto (`crypto.subtle`) |
| Key | 32 bytes from `crypto.getRandomValues`, shared via invite |
| Nonce | 12 random bytes, prepended to each frame |
| AAD | `<frame type> ‖ <owner> ‖ <session> ‖ <sender username>` |
| Layout | `nonce(12) ‖ ciphertext ‖ tag(16)` |

WebCrypto is chosen because it is built into Bun and Node ≥20 — no native
module, so single-binary cross-compilation keeps working (already verified for
darwin arm64/x64 and windows x64/arm64).

**Nonce safety.** Random 96-bit nonces are safe well past the message volumes a
per-keystroke editing session produces; the practical guidance is to stay under
2³² messages per key, and a room key's lifetime is one session. Should a session
approach that, the client must issue a new key rather than continue.

**AAD binds context.** Including room and sender prevents a frame from being
replayed into a different room or attributed to a different peer.

**Replay within a room** is not prevented, and for `0x01` it does not matter:
Yjs updates are idempotent and commutative, so re-delivery converges to the same
state. Replayed `0x02` awareness frames could momentarily resurrect stale
presence — cosmetic, and bounded by awareness timeouts.

**No forward secrecy** (§2). A future revision can add per-session ephemeral
key agreement between peers.

## 9. Relay responsibilities and quotas

State is in-memory only: room → set of connections. No database in v1.

An authenticated fan-out service is a general-purpose message bus, and it will
be found and abused. Quotas are load-bearing, not hardening:

| Limit | Starting value |
| --- | --- |
| Peers per room | 8 |
| Max frame size | 1 MiB |
| Frame rate per connection | 200/s sustained, burst 1000 |
| Byte rate per connection | 2 MiB/s |
| Rooms per user | 20 |
| Concurrent connections per user | 10 |
| Idle room TTL | 10 min after last peer leaves |

Exceeding a limit yields a `0x03` control frame naming the limit, then a close
with a specific code — never a silent drop.

These numbers are opening guesses and should be revised against real traffic
before any public launch.

## 10. Threat model

| Actor | Can | Cannot |
| --- | --- | --- |
| Relay operator | See usernames, room names, peer counts, frame sizes, timing | Read file contents or names |
| Network attacker | Observe TLS metadata | Read content; forge frames (AEAD) |
| Authenticated stranger | Join a room they know exists, consume a peer slot | Decrypt anything without the key |
| Invite holder | Read and write the whole session | — this is the capability model |
| Stolen `auth.json` | Impersonate the user until expiry; create rooms | Read past sessions (needs room keys) |

**Metadata is not protected.** `ashwin/acme-migration` tells the operator that
`ashwin` is working on something called `acme-migration`, and traffic timing
reveals working hours. Worth stating plainly in user-facing docs rather than
implying that "end-to-end encrypted" means nothing leaks.

**Compromised relay** can drop, delay, or reorder frames, and can replay them
(§8). It cannot forge or read content. Denial of service is always available to
the operator.

## 11. Compatibility and migration

- `PF_RELAY_TOKEN` self-hosting keeps working. Its documentation moves from
  `README.md` to `docs/self-hosting.md`, including the existing Tailscale +
  MagicDNS recipe.
- `--relay` defaults to the hosted service; pointing it at a self-hosted
  instance disables account features and falls back to shared-secret mode.
- Config precedence is unchanged: CLI flags → env → `pf-sync.config.json` →
  defaults.
- **Persistence remains compatible.** Because the relay stores opaque blobs, a
  future persistent-room feature can retain ciphertext without gaining the
  ability to read it.

## 12. CLI surface

```
tracker login                       # GitHub device flow
tracker logout                      # delete ~/.config/tracker/auth.json
tracker whoami                      # print authenticated username

tracker share [path]                # create room, print invite
    --session <name>                # default: basename of path
    --allow <user,...>              # restrict joins by username

tracker join <owner/session#key>    # attach to an existing room
    --root <path>                   # local directory to sync

tracker status                      # active session, peers, sync state
```

`share` and `join` both run the daemon in the foreground. The existing
`--relay/--room/--token/--root/--name` flags stay available for self-hosted use.

## 13. Rollout

1. **This RFC** — protocol, auth, crypto, quotas agreed.
2. **Relay rewrite** — replace `setupWSConnection` with authenticated fan-out;
   drop `levelup`/`leveldown`.
3. **Client crypto + auth** — encryption layer, device flow, config store.
4. **CLI restructure** — subcommands, `~/.config/tracker`.
5. **Release pipeline** — GitHub Actions building each platform natively (this
   also removes the need for `--compile-executable-path` workarounds), Releases
   with checksums, Homebrew tap, `npm i -g`.
6. **Open-source readiness** — `SECURITY.md` with a disclosure contact,
   `CONTRIBUTING.md`, CI, and this threat model surfaced in user docs.

Steps 2 and 3 must ship together: they are one breaking protocol change, and
shipping plaintext first would mean holding third-party source code in the clear
and a breaking bump later.

## 14. Open questions

1. **Name.** `tracker` is generic, contested on npm and Homebrew, and hard to
   search for. A distinctive name matters more for adoption than anything else
   in this document.
2. **Hosted domain** and who operates it.
3. **Operational commitment.** A public service implies uptime expectations, a
   security contact, abuse handling, and a privacy policy. E2E encryption
   shrinks this burden substantially but does not remove it.
4. **Quota calibration** (§9) before launch.
5. **Free-tier limits**, if there is ever a paid tier — cheaper to decide before
   people depend on today's limits.
6. **Line endings.** The daemon does no CRLF normalization
   (`src/daemon.js:69-71`, `:156`). Mixed Windows/macOS sessions will rewrite
   whole files on every save. A public release needs this fixed in the daemon,
   not deferred to editor configuration.
