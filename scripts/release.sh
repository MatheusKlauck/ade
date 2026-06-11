#!/usr/bin/env bash
# release.sh — Build, optionally sign & notarize ADE for macOS
#
# This script runs `npm run tauri build` and, if the appropriate env vars
# are set, signs and notarizes the .app bundle. It does NOT create a GitHub
# Release or upload artifacts — that is left to the human.
#
# Usage:
#   ./scripts/release.sh            # build only (no signing)
#   ./scripts/release.sh --sign     # build + sign + notarize (env vars required)
#
# Required env vars for --sign:
#   APPLE_ID          — Apple ID email
#   APPLE_PASSWORD    — App-specific password (https://appleid.apple.com)
#   APPLE_TEAM_ID     — Developer team ID
#   APPLE_CERTIFICATE — base64-encoded .p12 certificate
#   APPLE_CERTIFICATE_PASSWORD — password for the .p12
#
# See scripts/release.md for full documentation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SIGN_MODE="${1:-}"

cd "$PROJECT_ROOT"

# ── Build ──────────────────────────────────────────────────────────────
echo "==> Building ADE (npm run tauri build)…"
npm run tauri build

if [ "$SIGN_MODE" != "--sign" ]; then
  echo "==> Build complete. Skipping signing (pass --sign to enable)."
  exit 0
fi

# ── Validate env ───────────────────────────────────────────────────────
for var in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set. Required for --sign mode." >&2
    exit 1
  fi
done

# ── Decode certificate ─────────────────────────────────────────────────
echo "==> Importing signing certificate…"
CERT_PATH="$(mktemp)/ade-cert.p12"
echo "$APPLE_CERTIFICATE" | base64 --decode > "$CERT_PATH"

# Create a temporary keychain
KEYCHAIN_PATH="$(mktemp -d)/ade-build.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERT_PATH" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -k "$KEYCHAIN_PATH" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" > /dev/null 2>&1 || true

# ── Find the .app bundle ───────────────────────────────────────────────
APP_PATH="$(find "$PROJECT_ROOT/src-tauri/target/release/bundle/macos" -name '*.app' -maxdepth 1 | head -1)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: Could not find .app bundle in target/release/bundle/macos" >&2
  exit 1
fi

# ── Sign ────────────────────────────────────────────────────────────────
echo "==> Code-signing $APP_PATH…"
/usr/bin/codesign --force --deep --options runtime --timestamp \
  --keychain "$KEYCHAIN_PATH" \
  --sign "Developer ID Application" \
  "$APP_PATH"

# ── Notarize ───────────────────────────────────────────────────────────
echo "==> Creating ZIP for notarization…"
NOTARIZE_ZIP="$(mktemp)/ade-notarize.zip"
ditto -c -k --keepParent "$APP_PATH" "$NOTARIZE_ZIP"

echo "==> Submitting for notarization…"
xcrun notarytool submit "$NOTARIZE_ZIP" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "==> Stapling notarization ticket…"
xcrun stapler staple "$APP_PATH"

# ── Create DMG ─────────────────────────────────────────────────────────
echo "==> Creating DMG…"
DMG_NAME="ADE_0.1.0_aarch64.dmg"
DMG_PATH="$PROJECT_ROOT/src-tauri/target/release/bundle/dmg/$DMG_NAME"
mkdir -p "$(dirname "$DMG_PATH")"

hdiutil create -volname "ADE" \
  -srcfolder "$APP_PATH" \
  -ov -format UDZO \
  "$DMG_PATH"

echo "==> Signing DMG…"
/usr/bin/codesign --force --timestamp \
  --keychain "$KEYCHAIN_PATH" \
  --sign "Developer ID Application" \
  "$DMG_PATH"

# ── Cleanup ─────────────────────────────────────────────────────────────
echo "==> Cleaning up keychain…"
security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
rm -f "$CERT_PATH" "$NOTARIZE_ZIP"

echo "==> Done! Signed artifacts:"
echo "    App:  $APP_PATH"
echo "    DMG:  $DMG_PATH"