#!/usr/bin/env bash
# tauri-dev-runner.sh — drop-in replacement for `cargo` during `tauri dev`.
#
# WHY THIS EXISTS
# ---------------
# macOS ties a Keychain item's "Always Allow" grant to the *code signature* of
# the app that created it. `tauri dev` ships an unsigned / ad-hoc binary whose
# signature changes on every rebuild, so the grant never sticks and macOS
# re-prompts for your password on every launch (see scripts/macos-keychain-dev.md).
#
# This runner builds the app, signs the binary with a STABLE self-signed
# identity, then launches it. Same signature every time => "Always Allow"
# sticks => no more password prompts (after you approve it once).
#
# It is wired in ONLY for dev, via the `tauri:dev` npm script
# (`tauri dev --runner ../scripts/tauri-dev-runner.sh`). `tauri build` /
# release.sh keep using plain cargo and are unaffected.
#
# Tauri invokes us in place of `cargo`, e.g.:
#   tauri-dev-runner.sh run --no-default-features ... -- <app-args>
# so $1 is the cargo subcommand and anything after `--` is for the app.

set -eo pipefail

IDENTITY="${ADE_SIGNING_IDENTITY:-ADE Dev}"
BUNDLE_ID="dev.mk.ade"

# Drop the cargo subcommand ($1: run/build); we always `cargo build`.
shift || true

# Split remaining args into cargo args and app args (after a `--`).
cargo_args=()
app_args=()
seen_sep=0
for a in "$@"; do
  if [ "$seen_sep" -eq 1 ]; then
    app_args+=("$a")
  elif [ "$a" = "--" ]; then
    seen_sep=1
  else
    cargo_args+=("$a")
  fi
done

# `${arr[@]+...}` guards against "unbound variable" on empty arrays in bash 3.2
# (the version macOS ships at /bin/bash).
cargo build ${cargo_args[@]+"${cargo_args[@]}"}

# Locate the freshly built binary (Cargo package name is `ade`).
PROFILE="debug"
for a in ${cargo_args[@]+"${cargo_args[@]}"}; do
  [ "$a" = "--release" ] && PROFILE="release"
done
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
BIN="$TARGET_DIR/$PROFILE/ade"

if [ ! -x "$BIN" ]; then
  echo "tauri-dev-runner: built binary not found at $BIN" >&2
  exit 1
fi

# Sign with the stable self-signed identity so the Keychain ACL recognizes the
# binary across rebuilds. If the identity is missing we keep the dev loop
# working (unsigned) instead of blocking it.
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" "$BIN" \
    || echo "tauri-dev-runner: codesign failed — running unsigned (keychain will re-prompt)." >&2
else
  echo "tauri-dev-runner: signing identity '$IDENTITY' not found — running unsigned." >&2
  echo "  Create it once with: ./scripts/make-dev-signing-cert.sh" >&2
fi

exec "$BIN" ${app_args[@]+"${app_args[@]}"}
