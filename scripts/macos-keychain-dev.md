# macOS Keychain: getting rid of the dev password prompt

## What was happening

Every time the app started, macOS asked for your password and to "allow access
to keys". That prompt is **not** coming from the `keyring` crate — it is the
macOS **Keychain access control**.

Each Keychain item records *which app* is allowed to read it without prompting,
and macOS identifies the app by its **code signature**. The ADE GitHub tokens
are stored in the Keychain (`src-tauri/src/ipc/github.rs`), so reading them is
gated by that ACL.

In development the app is **unsigned** (ad-hoc), and the signature changes on
every rebuild. So:

- You click **"Always Allow"** → macOS records the current signature.
- Next rebuild has a different signature → macOS thinks it's a *different* app →
  **asks again.**

That's why "Always Allow" never stuck.

> Per-workspace tokens (`github_pat_{workspace_id}`) are stored as separate
> Keychain items, so with N workspaces you got N prompts. Once signing is in
> place each item is approved once and never asks again, so there's no need to
> consolidate them.

## The fix (development)

Sign every dev build with **one stable self-signed identity**. The signature
then stops changing across rebuilds, so "Always Allow" sticks.

### One-time setup

```bash
./scripts/make-dev-signing-cert.sh
```

This creates a self-signed code-signing identity named **`ADE Dev`** in your
login keychain. (If the CLI route prompts or fails, the script prints the
~6-click Keychain Access GUI fallback. You can also override the name:
`./scripts/make-dev-signing-cert.sh "My Name"` + set `ADE_SIGNING_IDENTITY`.)

### Run dev like this

```bash
npm run tauri:dev
```

instead of `npm run tauri dev`. This uses a custom runner
(`scripts/tauri-dev-runner.sh`) that does **build → codesign → launch**, so the
running binary always carries the `ADE Dev` signature.

- **First launch:** click **"Always Allow"** on the Keychain prompt (and on the
  one-time codesign key-access prompt, if it appears).
- **After that:** no more password prompts, even across rebuilds — and your
  tokens stay encrypted in the Keychain.

> The runner is wired in **only** for `npm run tauri:dev` (via `--runner`).
> `npm run tauri dev`, `npm run tauri build`, and `scripts/release.sh` are
> unchanged and keep using plain cargo. The `build.runner` config field was
> deliberately *not* used because it would apply to `tauri build` too and break
> bundling.

## Distribution (end users)

For the bundled app that ships to users, the same principle applies but you need
a **real Developer ID** (not the self-signed dev cert) so the app is trusted and
notarized. That path already exists:

- `scripts/release.sh --sign` signs with **Developer ID Application** and
  notarizes via `xcrun notarytool` — see `scripts/release.md`.
- It needs a paid **Apple Developer Program** account and these env vars:
  `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`,
  `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`.

Once notarized, end users approve the Keychain access **once** and are never
prompted again across app updates (the Developer ID designated requirement is
stable across versions).

### Optional: test the bundled app locally without an Apple account

You can sign a local (non-distributable) bundle with the same dev cert so it
doesn't prompt while you test it:

```bash
npm run tauri build
codesign --force --deep --sign "ADE Dev" \
  src-tauri/target/release/bundle/macos/ADE.app
```

This is for local testing only — it is not notarized and will warn on other
machines.
