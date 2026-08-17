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

// Public OAuth client for browser sign-in from the CLI. No secret: it is a
// native app using PKCE, and the id ships in every binary by design.
export const CLI_CLIENT_ID =
  process.env.TRACKER_CLI_CLIENT_ID || '032a8690-8f25-4251-add5-d396f48a77e9';

// Written as a branch on a build-time constant rather than a lookup table, so
// the bundler folds the comparison and drops the unused channel entirely. With a
// table, both channels' URLs survive into every binary and `strings` on a public
// release would list the internal hostnames.
export const channel =
  CHANNEL === 'public'
    ? {
        name: 'public',
        // Points at the hosted relay so invited pilots need no extra flag.
        //
        // Note what this means: a binary downloaded from a public release
        // connects to our infrastructure by default — our cost, our abuse
        // surface, and the user's code passing through (encrypted, but through).
        // That is a reasonable trade for a pilot cohort we invited. If this ever
        // becomes a genuinely public release, revisit it: strangers who find the
        // repo should have to opt in to someone else's server, not default into
        // it. --relay overrides, and `login` remembers whatever it is given.
        relay: 'wss://live.paraframes.org',
        web: 'https://github.com/paraframes-ai/tracker',
        dashboard: null,
        downloads: 'https://github.com/paraframes-ai/tracker/releases/latest',
        // Where a pilot gets a token. Derived from the relay origin would be
        // wrong — identity lives on the git host, not the relay.
        accounts: 'https://git.paraframes.org/user/settings/applications',
        // The git host to sign in against. Same for both channels: identity lives
        // on the git host, not the relay.
        gitHost: 'https://git.paraframes.org',
        docs: 'https://github.com/paraframes-ai/tracker#readme',
      }
    : {
        name: 'internal',
        relay: 'wss://live.paraframes.org',
        web: 'https://git.paraframes.org',
        dashboard: 'https://git.paraframes.org/live',
        downloads: 'https://live.paraframes.org/dl/',
        accounts: 'https://git.paraframes.org/user/settings/applications',
        gitHost: 'https://git.paraframes.org',
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
