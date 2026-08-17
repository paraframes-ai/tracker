// Build channel.
//
// A binary cannot tell at runtime where it was downloaded from — macOS records a
// source URL only for browser downloads, and curl records nothing — so the
// channel is stamped in at build time instead:
//
//   bun build --define TRACKER_CHANNEL='"public"' …
//
// 'internal' is the default so a plain `node src/cli.js` during development
// behaves like the in-house build.
//
// The two channels differ only in which URLs they point at. Same code, same
// protocol; a public build talks to whatever relay it is told to.

const CHANNEL = typeof TRACKER_CHANNEL !== 'undefined' ? TRACKER_CHANNEL : 'internal';

// Written as a branch on a build-time constant rather than a lookup table, so
// the bundler folds the comparison and drops the unused channel entirely. With a
// table, both channels' URLs survive into every binary and `strings` on a public
// release would list the internal hostnames.
export const channel =
  CHANNEL === 'public'
    ? {
        name: 'public',
        // Deliberately no default relay. A binary from a public release should
        // not silently connect to someone else's private infrastructure — their
        // cost, their abuse surface, the user's code. `login` stores whichever
        // relay is given, so --relay is needed once and then remembered.
        relay: null,
        web: 'https://github.com/paraframes-ai/tracker',
        dashboard: null,
        downloads: 'https://github.com/paraframes-ai/tracker/releases/latest',
        accounts: null,
        docs: 'https://github.com/paraframes-ai/tracker#readme',
      }
    : {
        name: 'internal',
        relay: 'wss://live.paraframes.org',
        web: 'https://git.paraframes.org',
        dashboard: 'https://git.paraframes.org/live',
        downloads: 'https://live.paraframes.org/dl/',
        accounts: 'https://git.paraframes.org/user/settings/applications',
        docs: 'https://git.paraframes.org/app',
      };

export const channelName = channel.name;

// Where to send someone for an access token. Public builds cannot know, since
// that depends on whichever relay they were pointed at.
export function accountsUrlFor(relay) {
  if (channel.accounts) return channel.accounts;
  if (!relay) return null;
  try {
    const u = new URL(relay.replace(/^ws/, 'http'));
    return `${u.origin}/user/settings/applications`;
  } catch {
    return null;
  }
}
