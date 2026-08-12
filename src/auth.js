// Client-side authentication (RFC 001 §5).
//
// GitHub's OAuth *device flow* is used because this is a CLI: there is no
// browser callback to catch and nowhere safe to keep a client secret. Device
// flow needs neither — only a public client_id.
//
// We request **no scopes**. The GitHub token is used exactly once, to let the
// relay resolve our login, and is never written to disk. So a leaked service
// token grants access to this service alone and confers no repository access.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The client id is public by design: device flow has no client secret, and this
// value ships inside every distributed binary. Overridable so self-hosters can
// point at their own OAuth app.
const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liRkXOV0SuKwsR5M';

const GITHUB_CLIENT_ID = process.env.TRACKER_GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID;

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tracker');
}

export const authPath = () => path.join(configDir(), 'auth.json');

export function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveAuth(auth) {
  await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
  // Written 0600 from the start rather than chmod'ed after, so the token is
  // never briefly world-readable.
  await fsp.writeFile(authPath(), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  return authPath();
}

export async function clearAuth() {
  await fsp.rm(authPath(), { force: true });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${text.slice(0, 200)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Steps 1-3 of §5.2. Returns a short-lived GitHub token.
async function githubDeviceFlow({ onPrompt }) {
  if (!GITHUB_CLIENT_ID) {
    throw new Error(
      'no GitHub client id — this build has none compiled in; set ' +
        'TRACKER_GITHUB_CLIENT_ID (see docs/rfc-001-hosted-relay.md §5)',
    );
  }

  const start = await postJson('https://github.com/login/device/code', {
    client_id: GITHUB_CLIENT_ID,
    scope: '',
  });

  onPrompt({ uri: start.verification_uri, code: start.user_code });

  // GitHub dictates the poll interval and can ask us to back off further; both
  // must be honoured or it starts returning errors.
  let interval = (start.interval || 5) * 1000;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: start.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const body = await res.json().catch(() => ({}));

    if (body.access_token) return body.access_token;
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += (body.interval || 5) * 1000;
      continue;
    }
    throw new Error(body.error_description || body.error || 'device flow failed');
  }
  throw new Error('login timed out — run tracker login again');
}

export async function login({ relay, onPrompt }) {
  const githubToken = await githubDeviceFlow({ onPrompt });
  const httpBase = relay.replace(/^ws/, 'http').replace(/\/+$/, '');
  const out = await postJson(`${httpBase}/v1/auth/exchange`, { githubToken });
  await saveAuth({ token: out.token, username: out.username, relay });
  return out;
}

// Dev-only counterpart to the relay's /v1/auth/dev. Exists so the transport and
// crypto layers can be exercised without registering an OAuth app; the relay
// refuses this endpoint unless TRACKER_DEV_AUTH=1.
export async function devLogin({ relay, username }) {
  const httpBase = relay.replace(/^ws/, 'http').replace(/\/+$/, '');
  const out = await postJson(`${httpBase}/v1/auth/dev`, { username });
  await saveAuth({ token: out.token, username: out.username, relay });
  return out;
}
