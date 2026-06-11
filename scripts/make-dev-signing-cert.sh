#!/usr/bin/env bash
# make-dev-signing-cert.sh — create a stable self-signed code-signing identity
# for local development, so `tauri dev` binaries can be signed consistently and
# the macOS Keychain stops re-prompting for your password on every launch.
#
# Run this ONCE. It is idempotent: if the identity already exists it exits early.
#
#   ./scripts/make-dev-signing-cert.sh            # creates identity "ADE Dev"
#   ./scripts/make-dev-signing-cert.sh "My Name"  # custom identity name
#
# This identity is for LOCAL DEV ONLY. It is NOT a Developer ID and cannot be
# used to notarize or distribute the app — for that, see scripts/release.md.

set -eo pipefail

IDENTITY="${1:-ADE Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

print_gui_fallback() {
  cat <<EOF

────────────────────────────────────────────────────────────────────────
If the steps above failed or kept prompting, create the certificate via the
Keychain Access GUI instead (rock-solid, ~6 clicks):

  1. Open "Keychain Access" (Spotlight: Keychain Access).
  2. Menu: Keychain Access > Certificate Assistant > Create a Certificate…
  3. Name:            $IDENTITY
     Identity Type:   Self Signed Root
     Certificate Type: Code Signing
  4. Click Create, then Done.
  5. Verify in a terminal:
        security find-identity -v -p codesigning
     You should see "$IDENTITY" listed.

Then run: npm run tauri:dev   (and click "Always Allow" the first time).
────────────────────────────────────────────────────────────────────────
EOF
}

# ── Already there? ───────────────────────────────────────────────────────
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "✓ Code-signing identity '$IDENTITY' already exists. Nothing to do."
  exit 0
fi

echo "==> Creating self-signed code-signing identity: '$IDENTITY'"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# ── Generate a self-signed cert with the codeSigning extended key usage ───
cat > "$WORKDIR/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -days 3650 -config "$WORKDIR/cert.cnf" >/dev/null 2>&1

openssl pkcs12 -export \
  -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
  -out "$WORKDIR/identity.p12" -passout pass:ade >/dev/null 2>&1

# ── Import the key+cert and let codesign use the private key ──────────────
security import "$WORKDIR/identity.p12" -k "$KEYCHAIN" -P "ade" \
  -T /usr/bin/codesign >/dev/null 2>&1 || true

# ── Trust the cert for code signing (user domain; may prompt once) ────────
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" \
  "$WORKDIR/cert.pem" >/dev/null 2>&1 || true

# ── Verify ────────────────────────────────────────────────────────────────
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "✓ Identity '$IDENTITY' created and trusted for code signing."
  echo
  echo "Next:"
  echo "  1. npm run tauri:dev"
  echo "  2. First launch: click \"Always Allow\" on the Keychain prompt (once)."
  echo "     The first codesign run may also ask for key access — click Always Allow."
  echo "  3. No more password prompts on subsequent launches."
else
  echo "✗ Could not verify the identity via the CLI." >&2
  print_gui_fallback
  exit 1
fi
