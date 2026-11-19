# Working conventions

- Use this repository as the only editable source of truth. Do not implement fixes in copied release/build folders.
- Keep the repository source-only: no node_modules, dist, build, .turbo, browser profiles, ZIPs or credentials in the working directory.
- Build and verify with `node scripts/workspace.mjs verify`. Dependencies and intermediate files go to an OS cache outside the repository; release files go to the adjacent `CookieSync-release` directory. `build` skips verification for already-tested source.
- Do not introduce a development auto-reload server or background control connection. Users download the production ZIP, extract it, and load/reload the extension in Chrome.
- Cookies and LocalStorage travel through WebDAV only. The GitHub Gist, Cloudflare KV and Google Drive cookie backends were removed in 1.12.0; do not reintroduce them. Treat legacy `selectedProvider` values as unconfigured and guide users to WebDAV.
- Auto push and pull default to enabled. Automatically discover visited HTTP(S) sites only within the bundled 300-site list and user overrides. Pause all automatic capture/push/pull and old jobs outside the list without deleting data; manual commands remain available. Config (site rules and preferences) travels through Chrome Sync by default or through the WebDAV config file channel (`CookieSync-config-v1.json`) when selected; that file never carries WebDAV credentials or the encryption password. Respect all existing discovery/global/per-site switches.
- Compare semantic SHA-256 fingerprints of plaintext, not ciphertext. Ignore ordering, timestamps and device store IDs in fingerprints. Encryption-policy changes must still rewrite remote data.
- When both ends changed since the last baseline, the newer write wins (per-domain `updateTime` vs the pending job's `capturedAt`, local clocks best effort); report the adoption in the sync status. Pending jobs without a captured timestamp (pre-1.12 upgrades) still require manual confirmation.
- Keep per-destination baselines and preserve pending local data on conflicts. Test in-flight changes, empty reads, individual edits/deletions, and unchanged-data skips.
- WebDAV conditional writes stay enabled by default. AList/OpenList compatibility is explicit opt-in with its non-atomic limitation documented.
- Update checks read GitHub Releases only for semantic version bumps; the verified ZIP auto-downloads with the downloads permission, but Chrome never self-replaces an unpacked extension — keep the guided three-step update flow and never claim fully automatic replacement.
- Site login profiles live in packages/shared/lib/siteProfiles: required login cookie names, a READ-ONLY health endpoint and the QR repair flow. Never point a health check at SSO-style endpoints that log out other devices; keep 115's rotating endpoints in the profile file only.
- Preserve the MIT license and upstream attribution. Never log cookie/token values or commit actual credentials.
- Repository destination: https://github.com/Xioaruan912/CookieSync. Preserve upstream and never force-push without explicit instruction.
- Keep the public manifest key in chrome-extension/google-config.json stable. Changing it breaks cross-device Chrome Sync identity.
