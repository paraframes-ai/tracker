#!/bin/sh
# tracker installer.
#
#   curl -fsSL https://live.paraframes.org/install.sh | sh
#
# This exists because `curl <binary-url> | sh` is the idiom people reach for, and
# doing that with a binary pipes 60 MB of Mach-O into the shell and leaves no file
# behind. That has already cost one person an afternoon. So: give them a script
# at that URL which does the right thing.
#
# Detects platform and architecture, verifies the published checksum, installs
# somewhere on PATH without requiring sudo if it can avoid it, and prints the
# next command.

set -eu

BASE="${TRACKER_BASE_URL:-https://live.paraframes.org/dl}"
BIN_NAME="tracker"

say() { printf '%s\n' "$*"; }
die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# --- platform ---------------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) plat="darwin" ;;
  Linux)  plat="linux"  ;;
  *) die "unsupported OS: $os. Windows users: download the .exe from $BASE/" ;;
esac

case "$arch" in
  arm64|aarch64) cpu="arm64" ;;
  x86_64|amd64)  cpu="x64"   ;;
  *) die "unsupported architecture: $arch" ;;
esac

# Only darwin ships both; linux is x64 only for now.
if [ "$plat" = "linux" ] && [ "$cpu" != "x64" ]; then
  die "no linux build for $arch yet"
fi

asset="${BIN_NAME}-${plat}-${cpu}"
say "Installing ${asset}…"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- download ---------------------------------------------------------------
curl -fsSL "$BASE/$asset" -o "$tmp/$BIN_NAME" || die "download failed: $BASE/$asset"
[ -s "$tmp/$BIN_NAME" ] || die "downloaded file is empty"

# --- verify -----------------------------------------------------------------
# A checksum file is published alongside the binaries. Verification is skipped
# only if it is unavailable, and says so rather than passing silently.
if curl -fsSL "$BASE/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " ${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}' || true)"
  if [ -n "$expected" ]; then
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$tmp/$BIN_NAME" | awk '{print $1}')"
    else
      actual="$(sha256sum "$tmp/$BIN_NAME" | awk '{print $1}')"
    fi
    [ "$actual" = "$expected" ] || die "checksum mismatch — expected $expected, got $actual"
    say "  checksum verified"
  else
    say "  ! no checksum published for $asset — skipping verification"
  fi
else
  say "  ! could not fetch SHA256SUMS — skipping verification"
fi

chmod +x "$tmp/$BIN_NAME"

# --- install ----------------------------------------------------------------
# Prefer somewhere already on PATH that we can write without sudo.
target=""
for dir in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) continue ;; esac
  if [ -d "$dir" ] && [ -w "$dir" ]; then target="$dir"; break; fi
done

if [ -z "$target" ]; then
  # Nothing writable on PATH: create ~/.local/bin, which most shells pick up.
  target="$HOME/.local/bin"
  mkdir -p "$target"
fi

mv "$tmp/$BIN_NAME" "$target/$BIN_NAME"
say "  installed to $target/$BIN_NAME"

case ":$PATH:" in
  *":$target:"*) ;;
  *)
    say ""
    say "  $target is not on your PATH. Add this to ~/.zshrc:"
    say "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

installed_version="$("$target/$BIN_NAME" version 2>/dev/null | head -1 || echo "unknown")"
say ""
say "$installed_version"
say ""
say "Next:"
say "  tracker login                       sign in through your browser"
say "  cd <your project> && tracker        start a session and copy the invite"
