// Browser sign-in for the CLI: OAuth2 authorization code with PKCE, over a
// loopback redirect.
//
// Why this shape. Forgejo does not implement the OAuth device flow, so the CLI
// cannot show a code and poll the way the GitHub path did. The standard answer
// for a native app is to listen on 127.0.0.1, open the system browser, and catch
// the redirect. It is also the nicer flow: the user is usually already signed in
// to the git host, so it is one click and nothing to paste.
//
// PKCE (S256) is what makes a client secret unnecessary — the verifier never
// leaves this process, so an intercepted authorization code is useless.

import crypto from 'node:crypto';
import http from 'node:http';
import { exec } from 'node:child_process';

// Forgejo requires an exact redirect_uri match, so these ports are registered on
// the OAuth app rather than chosen at random.
const PORTS = [53682, 53683, 53684];

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  // Best effort: the URL is printed as well, so a headless machine still works.
  exec(`${cmd} "${url}"`, () => {});
}

const page = (title, detail) =>
  `<!doctype html><meta charset=utf-8><title>tracker</title>
   <body style="font:16px -apple-system,system-ui,sans-serif;padding:3rem;text-align:center">
   <h2>${title}</h2><p style="color:#666">${detail}</p>`;

// Bind the first available registered port and return a promise for the callback.
export async function startCallbackServer() {
  for (const port of PORTS) {
    const attempt = await new Promise((resolve) => {
      const server = http.createServer();
      server.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? null : Promise.reject(err)));
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
    if (!attempt) continue;

    const server = attempt;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const done = new Promise((resolve, reject) => {
      server.on('request', (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error_description') || url.searchParams.get('error');
        const state = url.searchParams.get('state');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          error
            ? page('Sign-in failed', String(error))
            : page('Signed in', 'You can close this tab and return to the terminal.'),
        );
        server.close();
        if (error) reject(new Error(String(error)));
        else resolve({ code, state });
      });
      // Do not hang forever if the user abandons the browser.
      const timer = setTimeout(
        () => {
          server.close();
          reject(new Error('sign-in timed out after 5 minutes'));
        },
        5 * 60 * 1000,
      );
      timer.unref?.();
    });

    return { port, redirectUri, done, close: () => server.close() };
  }
  throw new Error(
    `could not listen on any of ${PORTS.join(', ')} — close whatever is using them, ` +
      'or sign in with --forgejo-token instead',
  );
}

// Builds the authorize URL for a given redirect and PKCE challenge.
export function authorizeUrl({ forgejoUrl, clientId, redirectUri, state, challenge }) {
  const u = new URL('/login/oauth/authorize', forgejoUrl);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', challenge);
  return u.toString();
}

// Runs the whole flow and returns Forgejo's access token.
export async function browserLogin({ forgejoUrl, clientId, onPrompt }) {
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));
  const server = await startCallbackServer();

  const url = authorizeUrl({
    forgejoUrl,
    clientId,
    redirectUri: server.redirectUri,
    state,
    challenge,
  });
  onPrompt(url);
  openBrowser(url);

  const { code, state: returned } = await server.done;
  if (returned !== state) throw new Error('state mismatch — sign in again');
  if (!code) throw new Error('no authorization code returned');

  const res = await fetch(new URL('/login/oauth/access_token', forgejoUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: server.redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `token exchange failed (${res.status})`);
  }
  return json.access_token;
}
