// Driving an editor to write its buffer to disk.
//
// Sync happens at the filesystem, so an editor that holds unsaved text is
// invisible to it. Most editors can be configured to write promptly; Xcode
// cannot — it has no autosave preference for source files, so the only way to
// make it real-time is to ask it to save.
//
// This uses Apple Events (`osascript` talking to the app's own scripting
// dictionary), not synthetic keystrokes. That distinction matters: keystrokes
// need the Accessibility permission, which grants control of the whole machine.
// Apple Events prompt once for one specific pairing — "tracker wants to control
// Xcode" — and nothing else.
//
// Every failure is non-fatal. A session must never stop because an editor could
// not be nudged.

import { execFile } from 'node:child_process';

const DEFAULT_INTERVAL_MS = 2000;

// Ask the app to save, but only if it is already running: launching Xcode
// because a sync session started would be obnoxious.
const SAVE_SCRIPTS = {
  // `application "Xcode" is running` deliberately avoids System Events: asking
  // System Events for the process list would need its own Automation grant, so
  // the user would face two prompts instead of one. This form also does not
  // launch Xcode — starting an IDE because a sync session began would be
  // obnoxious.
  xcode: `
    if application "Xcode" is running then
      tell application "Xcode" to save documents
      return "saved"
    else
      return "not-running"
    end if
  `,
};

function runOsascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || '').trim() });
      else resolve({ ok: true, out: String(stdout).trim() });
    });
  });
}

// Returns a stop function. Reports through the supplied logger rather than
// printing, so a detached session records it in its own log.
export function startAutosave({ ide, intervalMs = DEFAULT_INTERVAL_MS, log, warn }) {
  const script = SAVE_SCRIPTS[ide];
  if (!script) return () => {};
  if (process.platform !== 'darwin') {
    warn?.(`autosave for ${ide} is macOS-only; ignoring`);
    return () => {};
  }

  let stopped = false;
  let complained = false;
  let everWorked = false;

  const tick = async () => {
    if (stopped) return;
    const res = await runOsascript(script);
    if (res.ok) {
      if (!everWorked && res.out === 'saved') {
        everWorked = true;
        log?.(`autosave: driving ${ide} to save every ${Math.round(intervalMs / 1000)}s`);
      }
      return;
    }
    // -1743 is the macOS "not authorised to send Apple events" error.
    if (!complained) {
      complained = true;
      if (/-1743|not authori[sz]ed|Not authorized/.test(res.error)) {
        warn?.(
          `autosave needs permission to control ${ide}. macOS should have prompted; ` +
            'allow it under System Settings → Privacy & Security → Automation, ' +
            'or run with --no-autosave and save manually.',
        );
      } else {
        warn?.(`autosave could not drive ${ide}: ${res.error.split('\n')[0]}`);
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
