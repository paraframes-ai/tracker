// Line-ending normalization.
//
// The CRDT stores one canonical form — LF — and each machine keeps whatever
// convention its own files already use. Without this, a Windows editor saving
// CRLF and a macOS editor saving LF disagree on *every line* of the file, so the
// character-level merge rewrites the whole thing on every save, in both
// directions, forever.
//
// Normalizing at the disk boundary (not in the editor) means neither developer
// has to configure anything, and nobody's local file gains or loses \r.

const CRLF = /\r\n/g;
const LONE_LF = /(?<!\r)\n/g;

// Which convention does this text already use? Ties go to LF, and a file with no
// newlines at all is LF by default — on Windows the platform default takes over
// (see `platformEol`).
export function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  if (crlf === 0 && lf === 0) return null; // no newlines — caller decides
  return crlf > lf ? 'crlf' : 'lf';
}

export const platformEol = () => (process.platform === 'win32' ? 'crlf' : 'lf');

// disk -> CRDT
export const toLf = (text) => text.replace(CRLF, '\n');

// CRDT -> disk
export function fromLf(text, eol) {
  if (eol !== 'crlf') return text;
  return text.replace(LONE_LF, '\r\n');
}
