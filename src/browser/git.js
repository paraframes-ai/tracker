// ParaFrames git UI — our own frontend over Forgejo's REST API.
//
// Served on the same origin as Forgejo, so /api/v1 is reachable without CORS and
// without a proxy. Read-only for now: repo list, ref picker, file tree, file
// contents, commit log.
//
// Why a frontend over the API rather than restyling Forgejo: overriding Forgejo's
// Go templates means forking them, and upstream changes then break the forks
// quietly. Consuming a stable REST API gives full design control with none of
// that coupling.

const API = '/api/v1';
const TOKEN_KEY = 'tracker.forgejo.token';
const OAUTH_KEY = 'tracker.oauth';
// Public OAuth2 client registered in Forgejo. No secret: this is a browser app,
// so it uses the authorization-code flow with PKCE (S256).
const CLIENT_ID = '4f944f7b-2cdb-4b42-bfb9-eb6000b6f475';
const REDIRECT_URI = `${location.origin}/app/callback`;

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bytes = (n) =>
  n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

let token = localStorage.getItem(TOKEN_KEY) || '';

// Forgejo's REST API accepts *tokens only* — it ignores the web session entirely
// (an unauthenticated call returns "token is required"), so riding the browser's
// existing Forgejo login is not possible. Instead this signs in over OAuth2 with
// PKCE, which needs no pasting and no long-lived credential in localStorage.
//
// A manually pasted access token remains supported as a fallback.
let authMode = 'none'; // 'oauth' | 'token' | 'none'
let oauth = null;

function loadOAuth() {
  try {
    const o = JSON.parse(localStorage.getItem(OAUTH_KEY) || 'null');
    if (o && o.access_token && o.expires_at > Date.now() + 30_000) return o;
  } catch {
    /* fall through to a fresh sign-in */
  }
  return null;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

async function beginOAuth() {
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('pf.pkce', verifier);
  sessionStorage.setItem('pf.state', state);
  sessionStorage.setItem('pf.return', location.hash || '#/');
  const u = new URL('/login/oauth/authorize', location.origin);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', challenge);
  location.assign(u.toString());
}

// Handles /app/callback?code=...&state=...
async function completeOAuth() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const state = q.get('state');
  if (!code) throw new Error(q.get('error_description') || q.get('error') || 'no authorization code');
  if (!state || state !== sessionStorage.getItem('pf.state')) throw new Error('state mismatch — sign in again');
  const verifier = sessionStorage.getItem('pf.pkce');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier || '',
  });
  const res = await fetch('/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || 'token exchange failed');

  localStorage.setItem(
    OAUTH_KEY,
    JSON.stringify({
      access_token: j.access_token,
      refresh_token: j.refresh_token || null,
      expires_at: Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600_000),
    }),
  );
  sessionStorage.removeItem('pf.pkce');
  sessionStorage.removeItem('pf.state');
  const back = sessionStorage.getItem('pf.return') || '#/';
  location.replace(`/app${back}`);
}

async function api(path) {
  const headers = {};
  if (authMode === 'oauth' && oauth) headers.Authorization = `Bearer ${oauth.access_token}`;
  else if (authMode === 'token' && token) headers.Authorization = `token ${token}`;
  const res = await fetch(`${API}${path}`, { headers });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('unauthorized');
    err.auth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// routing: #/ , #/<owner>/<repo> , #/<owner>/<repo>/tree/<ref>/<path...>
// ---------------------------------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return { view: 'repos' };
  const parts = h.split('/').filter(Boolean);
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!repo) return { view: 'repos' };
  if (kind === 'commits') return { view: 'commits', owner, repo, ref };
  return { view: 'tree', owner, repo, ref, path: rest.join('/') };
}

const go = (hash) => {
  location.hash = hash;
};

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
function renderLogin(msg) {
  $('#main').innerHTML = `
    <div class="card narrow">
      <h2>Sign in</h2>
      <p class="muted">Sign in with your ParaFrames Git account. Nothing to copy or paste.</p>
      <p><button id="oauth" class="primary">Sign in with ParaFrames Git</button></p>
      <hr>
      <p class="muted small">Or use an access token (<a href="/user/settings/applications"
        target="_blank" rel="noreferrer">Settings → Applications</a>, scopes
        <code>read:user</code> and <code>read:repository</code>):</p>
      <div class="row">
        <input id="tok" type="text" inputmode="text" spellcheck="false" autocapitalize="off"
          autocorrect="off" autocomplete="off" name="pf-token-${Date.now()}"
          placeholder="paste token here">
        <button id="tokgo">Use token</button>
      </div>
      ${msg ? `<p class="warn">${esc(msg)}</p>` : ''}
    </div>`;
  $('#oauth').onclick = () => beginOAuth().catch((e) => renderLogin(e.message));
  const submit = () => {
    const v = $('#tok').value.trim();
    if (!v) return renderLogin('Paste a token first.');
    token = v;
    authMode = 'token';
    localStorage.removeItem(OAUTH_KEY);
    localStorage.setItem(TOKEN_KEY, v);
    render();
  };
  $('#tokgo').onclick = submit;
  const el = $('#tok');
  el.onkeydown = (e) => e.key === 'Enter' && submit();
  // Some browsers refuse to paste into a field they have decided is a new-password
  // field, so this is a plain text input; handle paste explicitly too, in case an
  // extension swallows the default behaviour.
  el.onpaste = (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (text) {
      e.preventDefault();
      el.value = text.trim();
      submit();
    }
  };
  el.focus();
}

async function viewRepos() {
  $('#crumb').innerHTML = '<span class="here">Repositories</span>';
  $('#main').innerHTML = '<div class="card muted">Loading…</div>';
  const repos = await api('/user/repos?limit=50');
  if (!repos.length) {
    $('#main').innerHTML = `<div class="card">
      <h2>No repositories yet</h2>
      <p class="muted">Create one in <a href="/repo/create">Forgejo</a>, or push an existing repo:</p>
      <pre class="snippet">git remote add origin https://git.paraframes.org/&lt;you&gt;/&lt;repo&gt;.git
git push -u origin main</pre></div>`;
    return;
  }
  $('#main').innerHTML = `<div class="list">${repos
    .map(
      (r) => `<a class="item" href="#/${esc(r.full_name)}">
        <div class="item-main">
          <span class="name">${esc(r.full_name)}</span>
          ${r.private ? '<span class="tag">private</span>' : ''}
          <div class="muted small">${esc(r.description || 'No description')}</div>
        </div>
        <div class="item-meta muted small">
          ${r.language ? `<span class="dot"></span>${esc(r.language)} · ` : ''}
          updated ${esc(ago(r.updated_at))}
        </div>
      </a>`,
    )
    .join('')}</div>`;
}

async function viewTree({ owner, repo, ref, path }) {
  const full = `${owner}/${repo}`;
  $('#main').innerHTML = '<div class="card muted">Loading…</div>';

  const meta = await api(`/repos/${full}`);
  const useRef = ref || meta.default_branch;
  const branches = await api(`/repos/${full}/branches`).catch(() => []);

  const crumbs = [`<a href="#/">Repositories</a>`, `<a href="#/${full}">${esc(repo)}</a>`];
  const segs = path ? path.split('/') : [];
  segs.forEach((seg, i) => {
    const sub = segs.slice(0, i + 1).join('/');
    crumbs.push(
      i === segs.length - 1
        ? `<span class="here">${esc(seg)}</span>`
        : `<a href="#/${full}/tree/${encodeURIComponent(useRef)}/${sub}">${esc(seg)}</a>`,
    );
  });
  $('#crumb').innerHTML = crumbs.join('<span class="sep">/</span>');

  const entry = await api(`/repos/${full}/contents/${path}?ref=${encodeURIComponent(useRef)}`);

  const refPicker = `<select id="refsel">${branches
    .map((b) => `<option ${b.name === useRef ? 'selected' : ''}>${esc(b.name)}</option>`)
    .join('')}</select>`;
  const bar = `<div class="bar">
      ${refPicker}
      <a class="btn" href="#/${full}/commits/${encodeURIComponent(useRef)}">Commits</a>
      <a class="btn" href="/${full}" target="_blank" rel="noreferrer">Open in Forgejo</a>
      <span class="spacer"></span>
      <code class="clone">git clone ${location.origin}/${full}.git</code>
    </div>`;

  // A single file, not a directory.
  if (!Array.isArray(entry)) {
    const text = entry.encoding === 'base64' ? atob(entry.content || '') : (entry.content ?? '');
    const looksBinary = /\u0000/.test(text); // NUL byte, not whitespace
    const lines = text.split('\n');
    $('#main').innerHTML =
      bar +
      `<div class="card file">
        <div class="file-head"><b>${esc(entry.name)}</b>
          <span class="muted small">${bytes(entry.size)} · ${lines.length} lines</span></div>
        ${
          looksBinary
            ? '<div class="muted pad">Binary file not shown.</div>'
            : `<pre class="code">${lines
                .map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`)
                .join('\n')}</pre>`
        }
      </div>`;
  } else {
    const up = segs.length
      ? `<a class="row-item" href="#/${full}/tree/${encodeURIComponent(useRef)}/${segs.slice(0, -1).join('/')}">
           <span class="ico">↩</span><span>..</span></a>`
      : '';
    const sorted = entry.sort(
      (a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1),
    );
    $('#main').innerHTML =
      bar +
      `<div class="card"><div class="rows">${up}${sorted
        .map(
          (f) => `<a class="row-item" href="#/${full}/tree/${encodeURIComponent(useRef)}/${esc(f.path)}">
            <span class="ico">${f.type === 'dir' ? '▸' : '·'}</span>
            <span class="fname">${esc(f.name)}</span>
            <span class="muted small right">${f.type === 'dir' ? '' : bytes(f.size)}</span>
          </a>`,
        )
        .join('')}</div></div>`;
  }

  const sel = $('#refsel');
  if (sel) sel.onchange = () => go(`#/${full}/tree/${encodeURIComponent(sel.value)}/${path}`);
}

async function viewCommits({ owner, repo, ref }) {
  const full = `${owner}/${repo}`;
  $('#crumb').innerHTML = `<a href="#/">Repositories</a><span class="sep">/</span><a href="#/${full}">${esc(repo)}</a><span class="sep">/</span><span class="here">Commits</span>`;
  $('#main').innerHTML = '<div class="card muted">Loading…</div>';
  const commits = await api(`/repos/${full}/commits?limit=50${ref ? `&sha=${encodeURIComponent(ref)}` : ''}`);
  $('#main').innerHTML = `<div class="card"><div class="rows">${commits
    .map(
      (c) => `<div class="row-item commit">
        <div>
          <div class="cmsg">${esc(c.commit.message.split('\n')[0])}</div>
          <div class="muted small">${esc(c.commit.author.name)} · ${esc(ago(c.commit.author.date))}</div>
        </div>
        <a class="sha" href="/${full}/commit/${c.sha}" target="_blank" rel="noreferrer">${c.sha.slice(0, 8)}</a>
      </div>`,
    )
    .join('')}</div></div>`;
}

async function render() {
  oauth = loadOAuth();
  authMode = oauth ? 'oauth' : token ? 'token' : 'none';
  if (authMode === 'none') return renderLogin();
  const r = route();
  try {
    if (r.view === 'repos') await viewRepos();
    else if (r.view === 'commits') await viewCommits(r);
    else await viewTree(r);
  } catch (err) {
    if (err.auth) {
      localStorage.removeItem(TOKEN_KEY);
      token = '';
      return renderLogin('That token was rejected — check its scopes and try again.');
    }
    $('#main').innerHTML = `<div class="card warn">${esc(err.message)}</div>`;
  }
}

async function whoami() {
  if (authMode === 'none') return;
  try {
    const u = await api('/user');
    $('#who').innerHTML =
      `<span class="muted small">${esc(u.login)}</span><button id="out" class="link">sign out</button>`;
    $('#out').onclick = () => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(OAUTH_KEY);
      token = '';
      oauth = null;
      authMode = 'none';
      $('#who').innerHTML = '';
      render();
    };
  } catch {
    /* render() surfaces auth problems */
  }
}

window.addEventListener('hashchange', render);

if (location.pathname.replace(/\/+$/, '') === '/app/callback') {
  completeOAuth().catch((err) => {
    document.querySelector('#main').innerHTML =
      `<div class="card narrow warn">Sign-in failed: ${esc(err.message)}
        <p><a href="/app">Try again</a></p></div>`;
  });
} else {
  render().then(whoami);
}
