// Desktop notifications.
//
// A detached session logs to a file nobody reads, so problems are discovered by
// noticing that files have gone stale. These surface the four things worth
// interrupting someone for: a peer arriving, a peer leaving, sync stalling, and
// a fatal error.
//
// macOS `display notification` goes through Notification Center and needs no
// Accessibility permission — unlike sending keystrokes. Linux uses notify-send
// when present. Anywhere else this is a no-op: a missing notification must never
// break a sync session.

import { execFile } from 'node:child_process';

const enabled = process.env.TRACKER_NO_NOTIFY !== '1';

const escapeForAppleScript = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

let lastSent = 0;
const MIN_GAP_MS = 2000; // a flapping peer must not produce a notification storm

export function notify(title, message) {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastSent < MIN_GAP_MS) return;
  lastSent = now;

  try {
    if (process.platform === 'darwin') {
      const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
      execFile('osascript', ['-e', script], () => {});
    } else if (process.platform === 'linux') {
      execFile('notify-send', [title, message], () => {});
    }
  } catch {
    /* notifications are a convenience; never let one break the session */
  }
}
