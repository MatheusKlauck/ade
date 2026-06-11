# ADE Release Guide

This document explains how to build, sign, notarize, and publish ADE releases
on macOS. It is intended to be run manually by a human — there is no CI pipeline.

## Prerequisites

1. **Xcode Command Line Tools** — `xcode-select --install`
2. **Apple Developer ID** — You need a "Developer ID Application" certificate
   installed in your keychain (or provide it via environment variable).
3. **App-specific password** — Generate at https://appleid.apple.com →
   Sign-In and Security → App-Specific Passwords.
4. **Rust toolchain** — `rustup target add aarch64-apple-darwin` (and
   `x86_64-apple-darwin` if you want universal builds).

## Environment Variables

The following environment variables are required for signing and notarization:

| Variable | Description |
|---|---|
| `APPLE_ID` | Your Apple ID email address (e.g. `you@example.com`) |
| `APPLE_PASSWORD` | App-specific password generated at appleid.apple.com |
| `APPLE_TEAM_ID` | Your Developer team ID (found in developer.apple.com → Membership) |
| `APPLE_CERTIFICATE` | Base64-encoded .p12 Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the .p12 |

### How to create the .p12 and encode it

1. Open Keychain Access → find your "Developer ID Application" certificate.
2. Right-click → "Export…" → save as `.p12` with a password.
3. Encode: `base64 -i YourCert.p12 | pbcopy`
4. Set: `export APPLE_CERTIFICATE="$(pbpaste)"`

## Building (unsigned, for local testing)

```bash
npm run tauri build
```

This produces:

- `src-tauri/target/release/bundle/macos/ADE.app`
- `src-tauri/target/release/bundle/dmg/ADE_0.1.0_aarch64.dmg` (may not exist without signing)

## Building + Signing + Notarizing

```bash
# Set all env vars above, then:
./scripts/release.sh --sign
```

This runs the full pipeline:

1. `npm run tauri build`
2. Imports the .p12 certificate into a temporary keychain
3. Code-signs the .app with `--options runtime` (hardened runtime)
4. Submits for notarization via `notarytool submit --wait`
5. Staples the notarization ticket with `stapler staple`
6. Creates a signed .dmg
7. Cleans up the temporary keychain

## Auto-Update Configuration

ADE uses `tauri-plugin-updater` (v2) to check for updates. The configuration
lives in `src-tauri/tauri.conf.json` under `plugins.updater`:

```json
"updater": {
  "endpoints": [
    "https://github.com/mk/ade/releases/latest/download/latest.json"
  ],
  "pubkey": ""
}
```

### Generating the update signature key pair

For **local testing** you can leave `pubkey` empty and updates will be accepted
without signature verification. For production, generate a key pair:

```bash
npm run tauri signer generate -w ~/.tauri/ade-updater.key
```

This prints the **public key** — paste it into `tauri.conf.json` as `pubkey`.
The **private key** is written to the file you specified; set
`TAURI_SIGNING_PRIVATE_KEY` when running the build to sign update bundles.

### Publishing a release

1. Run the build (with or without signing).
2. Create the `latest.json` update manifest:

```bash
npm run tauri build -- --bundles app
```

The Tauri bundler generates the update manifest automatically when
`TAURI_SIGNING_PRIVATE_KEY` is set. It appears at
`src-tauri/target/release/bundle/update/ADE.app.tar.gz` alongside the
`.sig` file and a `latest.json` manifest.

3. Create a GitHub Release at https://github.com/mk/ade/releases with:
   - Tag: `v0.1.0`
   - Title: `v0.1.0`
   - Upload: `ADE.app.tar.gz`, `ADE.app.tar.gz.sig`, `latest.json`, and the
     `.dmg` file.

### How the update endpoint works

When a user's ADE checks for updates, it fetches the `latest.json` URL from
`plugins.updater.endpoints`. The JSON contains:

```json
{
  "version": "0.1.0",
  "notes": "Initial release",
  "pub_date": "2026-06-10T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/mk/ade/releases/download/v0.1.0/ADE.app.tar.gz",
      "signature": "<content of .sig file>"
    }
  }
}
```

You must create this file (or let Tauri generate it) and upload it to the
GitHub Release so the endpoint resolves.

## Troubleshooting

| Problem | Fix |
|---|---|
| `codesign` fails with "no identity found" | Ensure the .p12 is imported and the keychain is unlocked |
| `notarytool` returns 403 | Check APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID |
| App launches but updater says "no update" | Verify `latest.json` is reachable at the endpoint URL and has the correct version |
| DMG is unsigned | The script signs the DMG too; if it fails, sign manually: `codesign --force --timestamp --sign "Developer ID Application" ADE_0.1.0_aarch64.dmg` |
| Gatekeeper blocks the app | Notarization was skipped or failed. Re-run with `--sign` or `xattr -cr ADE.app` for local testing |

## Notarization — Do NOT automate

The `release.sh --sign` flag runs notarization locally. It is designed for a
human to execute on their own machine. The Apple credentials are never stored
in the repository. Do not put them in CI secrets or scripts — manage them
through your keychain or password manager.