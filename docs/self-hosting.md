# Self-hosting the relay

The hosted relay (`tracker login` / `tracker share`) is the path of least
resistance. Self-hosting stays fully supported for anyone who would rather not
route even ciphertext through someone else's machine.

There are two options, and they are not equivalent:

| | **A. Legacy shared-secret relay** | **B. Authenticated E2E relay** |
| --- | --- | --- |
| Entry point | `src/relay.cjs` | `src/server/index.js` |
| Encryption | None — relay sees plaintext | End-to-end; relay sees ciphertext |
| Auth | One shared `PF_RELAY_TOKEN` | Per-user tokens (GitHub or dev) |
| Addressing | `--room=<name>` | `owner/session` + invite key |
| Client | `tracker sync` / `npm run sync` | `tracker share` / `tracker join` |
| Needs a private network | Strongly recommended | No |

Option A is the original design and still works unchanged. It has no encryption
of its own, so it must not be exposed to the public internet — put it on a
private network (Tailscale) or behind TLS with a token, as below.

Option B is the design in [RFC 001](./rfc-001-hosted-relay.md). Because content
is encrypted end-to-end, exposing it publicly is safe by design.

---

## Option A — legacy shared-secret relay on a GCE e2-small

Using **Tailscale + MagicDNS** — no public exposure, no domain, no manual certs.
The relay lives on your private tailnet and both machines reach it by its
MagicDNS name.

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

Install Tailscale on **every developer machine** too and `tailscale up` into the
same tailnet — that is how they reach the relay by name.

> **If the certificate does not issue.** `tailscale serve` provisions its cert
> lazily, on the first HTTPS request. A failure there is reported as a bare TLS
> error, and the useful detail is in `journalctl -u tailscaled`. Read that before
> retrying: each attempt consumes one of Let's Encrypt's five failed
> authorizations per hostname per hour, and a retry loop will lock you out for
> the rest of the hour. Failed authorizations age out on their own.

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
tailscale serve status              # shows the URL, tailnet-only
```

To keep the node's `:443` free for something else, use a different port —
`sudo tailscale serve --bg --https=8443 1234` — and add `:8443` to the relay URL
on each client.

> On a machine that already runs Tailscale, check `which -a tailscale`. A
> user-local install in `~/.local/bin` shadows `/usr/bin/tailscale` and will
> print a spurious client/daemon version-skew warning on every command.

### 7. Verify and connect

```bash
curl https://pf-relay.<your-tailnet>.ts.net     # -> paraframes-live relay ok
```

Then on each machine (all on the tailnet, project checked out):

```bash
tracker sync -- \
  --relay=wss://pf-relay.<your-tailnet>.ts.net \
  --room=paraframes \
  --token=THE-TOKEN \
  --root=/path/to/ParaFrames \
  --name=you
```

`npm run sync -- ...` is equivalent and must be run from a checkout of this
repo — that is where the `sync` script lives.

**Updating:**
`cd /opt/paraframes-live && sudo git pull && sudo npm install --omit=dev && sudo systemctl restart pf-relay`

> Since all tailnet traffic is already WireGuard-encrypted, you can skip step 6
> and connect with plain `--relay=ws://pf-relay.<tailnet>.ts.net:1234` — but then
> set `HOST=0.0.0.0` in the systemd unit so the relay listens on the tailnet
> interface.

---

## Option B — self-hosting the authenticated E2E relay

```bash
npm install --omit=dev
PORT=8787 TRACKER_JWT_PRIVATE_KEY="$(cat jwt.pem)" npm run server
```

| Env | Meaning |
| --- | --- |
| `PORT` / `HOST` | Listen address (default `0.0.0.0:8787`) |
| `TRACKER_JWT_PRIVATE_KEY_FILE` | Path to an Ed25519 private key PEM (preferred) |
| `TRACKER_JWT_PRIVATE_KEY` | The PEM itself, if you would rather not use a file |
| `TRACKER_TOKEN_TTL_DAYS` | Token lifetime, default 30 |
| `TRACKER_DEV_AUTH=1` | Enables `/v1/auth/dev`. **Never set in production** |

Generate a signing key:

```bash
openssl genpkey -algorithm ed25519 -out jwt.pem
```

If neither key variable is set the server generates an ephemeral one, so every
restart silently invalidates every token already issued. That is fine for local
testing and wrong for anything else.

For a systemd deployment, use `deploy/pf-auth-relay.service` — it runs alongside
the legacy `pf-relay.service` so shared-secret sessions keep working while
clients migrate.

Put it behind a TLS terminator (Caddy, nginx, a cloud load balancer) so clients
can use `wss://`. Content is already end-to-end encrypted, but TLS still protects
the bearer token and the metadata.

### GitHub login

`tracker login` needs an OAuth app with **device flow enabled**, and the client
id passed to the CLI:

```bash
export TRACKER_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
tracker login --relay=wss://relay.example.com
```

No client secret is involved and no scopes are requested — the relay uses the
resulting GitHub token once to resolve your login, then discards it.

### Local testing without an OAuth app

```bash
# terminal 1
TRACKER_DEV_AUTH=1 PORT=8787 npm run server

# terminal 2
tracker login --dev=alice --relay=ws://127.0.0.1:8787
tracker share ./project --session=demo --relay=ws://127.0.0.1:8787
```

`/v1/auth/dev` mints a token for any username, which is exactly why it is
refused unless `TRACKER_DEV_AUTH=1` is set explicitly.
