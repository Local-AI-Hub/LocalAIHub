# Manifest Signing

Local AI Hub now verifies `tools-manifest.json` with a detached Ed25519 signature instead of a pinned hash, so the remote Store manifest can be updated safely without shipping a new app version.

## Current signing key

- Private key path on this PC: `C:\Users\Dell\AppData\Local\LocalAIHubSigning\tools-manifest-signing.private.pem`
- Public key: baked into the app in `electron/services/manifestSignatureService.js`
- Signature file committed with the manifest: `electron/config/tools-manifest.json.sig`

Do not regenerate the keypair unless you are planning a new app release that bakes in a new public key. If the private key changes, existing app builds will reject future manifest updates.

## Re-sign the manifest after editing it

1. Edit `electron/config/tools-manifest.json`.
2. Run `npm run sign:manifest` from the repo root.
3. Commit both `electron/config/tools-manifest.json` and `electron/config/tools-manifest.json.sig` together.
4. Push them together when you want the remote Store manifest to update.

## Alternate key location

If you move the private key to another location, either:

- set `LOCALAIHUB_MANIFEST_PRIVATE_KEY_PATH` to the full PEM path, or
- run `node scripts/sign-tools-manifest.js --private-key C:\full\path\to\tools-manifest-signing.private.pem`

## Verify the current signature

Run:

```powershell
npm run verify:manifest
```

## What the signing script does

- Canonicalizes `tools-manifest.json` to stable JSON formatting
- Signs the canonical manifest payload with the private key
- Writes `tools-manifest.json.sig`
- Verifies the signature immediately before exiting
