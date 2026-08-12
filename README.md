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

The relay is what connects the two of you. **The daemons never talk to each
other directly** — they both dial *out* to the relay (which firewalls/NAT
allow), and the relay forwards edits between them. So it needs to live at a
fixed, public address both Macs can reach. A **GCE e2-small** (2 vCPU / 2 GB)
is plenty — the relay only shuttles tiny text deltas.

For a quick local smoke test:

```bash
PF_RELAY_TOKEN=some-shared-secret npm run relay
# listens on ws://0.0.0.0:1234  (fine for localhost; use TLS for real internet)
```

For real internet use, deploy it properly with auto-restart and TLS — see
**[Deploying the relay on a GCE e2-small](#deploying-the-relay-on-a-gce-e2-small)**
below.

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

## Deploying the relay on a GCE e2-small

Using **Tailscale + MagicDNS** — no public exposure, no domain, no manual certs.
The relay lives on your private tailnet and both Macs reach it by its MagicDNS
name. Ready-made config lives in [`deploy/`](deploy/).

**Architecture:** the relay listens on `127.0.0.1:1234`. `tailscale serve`
publishes it over HTTPS on the VM's MagicDNS name (e.g.
`pf-relay.<your-tailnet>.ts.net`), provisioning the TLS cert automatically.
Nothing is exposed to the public internet — only devices on your tailnet can
reach it, and Tailscale needs **no inbound firewall ports** at all.

### 1. Create the VM (no public ports needed)

```bash
gcloud compute instances create pf-relay \
  --machine-type=e2-small --image-family=debian-12 --image-project=debian-cloud
```

No `gcloud firewall-rules` — Tailscale connects outbound, so you never open a
public port.

### 2. Install Node, clone, install deps

```bash
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo git clone https://github.com/paraframes-ai/tracker /opt/paraframes-live
cd /opt/paraframes-live
sudo npm install --omit=dev
```

### 3. Install Tailscale and join your tailnet

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # opens a login URL — authenticate to your tailnet
tailscale status             # note this machine's MagicDNS name
```

In the [Tailscale admin console](https://login.tailscale.com/admin/dns), make
sure **MagicDNS** is enabled and turn on **HTTPS Certificates** (both under the
DNS tab). `tailscale serve` needs the HTTPS toggle to mint the cert.

Install Tailscale on **both Macs** too and `tailscale up` into the same tailnet —
that's how they reach the relay by name.

### 4. Create the run user (+ optional shared secret)

```bash
sudo useradd --system --no-create-home pfrelay
sudo chown -R pfrelay:pfrelay /opt/paraframes-live

# Optional: the tailnet is already private, but a token adds defense-in-depth.
# Leave the file empty to run without one.
echo "PF_RELAY_TOKEN=$(openssl rand -hex 16)" | sudo tee /etc/paraframes-live.env
sudo chmod 600 /etc/paraframes-live.env
sudo cat /etc/paraframes-live.env   # note the token if you set one
```

### 5. Start the relay as a service

```bash
sudo cp deploy/pf-relay.service /etc/systemd/system/pf-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now pf-relay
sudo systemctl status pf-relay      # should be active (running)
```

Auto-starts on boot and restarts if it crashes. It listens only on
`127.0.0.1:1234` (per the unit file).

### 6. Publish it over HTTPS on the MagicDNS name

```bash
sudo tailscale serve --bg 1234      # proxies https://<magicdns-name>/ -> :1234
tailscale serve status              # shows the public-within-tailnet URL
```

### 7. Verify and connect

```bash
# from the VM or either Mac (must be on the tailnet):
curl https://pf-relay.<your-tailnet>.ts.net     # -> paraframes-live relay ok
```

Then on each Mac (both on the tailnet, Xcode project checked out):

```bash
npm run sync -- \
  --relay=wss://pf-relay.<your-tailnet>.ts.net \
  --room=paraframes \
  --token=THE-TOKEN \          # omit if you left the env file empty
  --root=/path/to/ParaFrames \
  --name=you
```

**Updating the relay later:**
`cd /opt/paraframes-live && sudo git pull && sudo npm install --omit=dev && sudo systemctl restart pf-relay`

> Simpler alternative: since all tailnet traffic is already WireGuard-encrypted,
> you can skip step 6 entirely and connect with plain
> `--relay=ws://pf-relay.<your-tailnet>.ts.net:1234` — but then set `HOST=0.0.0.0`
> in the systemd unit so the relay listens on the tailnet interface.

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
