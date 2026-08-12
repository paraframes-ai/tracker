// Browser session viewer.
//
// Joins a live session as a real peer and decrypts everything locally: the room
// key comes from the URL fragment, which browsers never send to the server. So
// this page shows file contents that the relay itself cannot read.
//
// It connects read-only — it observes the shared document and never contributes
// an edit, so opening the viewer cannot alter anyone's checkout.

import * as Y from 'yjs';
import { EncryptedProvider } from '../provider.js';
import { fromBase64Url } from '../crypto.js';

const KEY = 'tracker.dashboard.token';
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function parseTarget() {
  // /s/<owner>/<session>#<key>
  const m = /^\/s\/([^/]+)\/([^/?#]+)/.exec(location.pathname);
  const key = location.hash.replace(/^#/, '');
  if (!m || !key) return null;
  return { owner: decodeURIComponent(m[1]), session: decodeURIComponent(m[2]), key };
}

const state = { files: new Map(), selected: null, peers: [], status: 'connecting' };

function renderTree() {
  const names = [...state.files.keys()].sort();
  $('count').textContent = names.length ? `${names.length} files` : 'no files yet';
  $('tree').innerHTML = names
    .map(
      (n) =>
        `<li${n === state.selected ? ' class="sel"' : ''} data-f="${esc(n)}"><span>${esc(n)}</span></li>`,
    )
    .join('');
  for (const li of $('tree').querySelectorAll('li')) {
    li.onclick = () => {
      state.selected = li.dataset.f;
      renderTree();
      renderFile();
    };
  }
}

function renderFile() {
  const name = state.selected;
  if (!name) {
    $('file').innerHTML = '<div class="empty">Select a file to view it.</div>';
    return;
  }
  const text = state.files.get(name) ?? '';
  const lines = text.split('\n');
  $('file').innerHTML =
    `<div class="fname">${esc(name)} <span class="muted">· ${lines.length} lines · ${text.length} chars</span></div>` +
    `<pre><code>${lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')}</code></pre>`;
}

function renderStatus() {
  $('status').textContent = state.status;
  $('status').className = 'pill ' + (state.status === 'live' ? 'live' : 'idle');
  $('peers').textContent = state.peers.length ? state.peers.join(', ') : 'nobody else connected';
}

async function main() {
  const target = parseTarget();
  if (!target) {
    $('app').innerHTML =
      '<div class="card warn">This URL is missing a session or key. Open a viewer link of the form <code>/s/&lt;owner&gt;/&lt;session&gt;#&lt;key&gt;</code>.</div>';
    return;
  }
  const token = localStorage.getItem(KEY);
  if (!token) {
    $('app').innerHTML =
      '<div class="card">You need to sign in first. <a href="/dashboard">Go to the dashboard</a>, sign in, then reopen this link.</div>';
    return;
  }

  let roomKey;
  try {
    roomKey = fromBase64Url(target.key);
  } catch (e) {
    $('app').innerHTML = `<div class="card warn">Bad room key in the link: ${esc(e.message)}</div>`;
    return;
  }

  $('title').textContent = `${target.owner}/${target.session}`;
  document.title = `${target.owner}/${target.session} — ParaFrames Live`;

  const doc = new Y.Doc();
  const files = doc.getMap('files');

  const sync = () => {
    state.files = new Map();
    files.forEach((ytext, name) => state.files.set(name, ytext.toString()));
    renderTree();
    renderFile();
  };

  files.observe(sync);
  files.observeDeep(sync);

  const provider = new EncryptedProvider({
    relay: location.origin,
    owner: target.owner,
    session: target.session,
    username: 'viewer',
    token,
    roomKey,
    doc,
    WebSocketImpl: WebSocket,
    readOnly: true,
  });

  provider.on('status', ({ status }) => {
    state.status = status === 'connected' ? 'live' : status;
    renderStatus();
  });
  provider.on('peers', (peers) => {
    state.peers = peers;
    renderStatus();
  });
  provider.on('sync', () => {
    state.status = 'live';
    renderStatus();
    sync();
  });
  provider.on('fatal', ({ reason }) => {
    $('app').innerHTML = `<div class="card warn">${esc(reason)}</div>`;
  });

  // The viewer's own username comes from its token, not this field; the relay
  // rejects any mismatch. Set it after construction so AAD uses the real one.
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    provider.username = String(claims.username).toLowerCase();
  } catch {
    /* fall through — the relay will reject if this is wrong */
  }

  await provider.connect();
  renderStatus();
}

main();
