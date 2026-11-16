# Working conventions

- Use this repository as the only editable source of truth. Do not implement fixes in copied release/build folders.
- Keep the repository source-only: no node_modules, dist, build, .turbo, browser profiles, ZIPs or credentials in the working directory.
- Build and verify with `node scripts/workspace.mjs verify`. Dependencies and intermediate files go to an OS cache outside the repository; release files go to the adjacent `CookieSync-release` directory. `build` skips verification for already-tested source.
- Do not introduce a development auto-reload server or background control connection. Users download the production ZIP, extract it, and load/reload the extension in Chrome.
- Auto push and pull default to enabled. Automatically discover visited HTTP(S) sites only within the bundled 300-site list and user overrides. Pause all automatic capture/push/pull and old jobs outside the list without deleting data; manual commands remain available. Sync per-domain overrides through Chrome Sync and the separate Drive appData policy file before any automatic replay. Respect all existing discovery/global/per-site switches.
- Compare semantic SHA-256 fingerprints of plaintext, not ciphertext. Ignore ordering, timestamps and device store IDs. Encryption-policy changes must still rewrite remote data.
- Keep per-destination baselines and preserve pending local data on conflicts. Test in-flight changes, empty reads, individual edits/deletions, and unchanged-data skips.
- WebDAV conditional writes stay enabled by default. AList/OpenList compatibility is explicit opt-in with its non-atomic limitation documented.
- Preserve GitHub Gist, Cloudflare KV, MIT license and upstream attribution. Never log cookie/token values or commit actual credentials.
- Repository destination: https://github.com/Xioaruan912/CookieSync. Preserve upstream and never force-push without explicit instruction.
- Keep the public manifest key in chrome-extension/google-config.json stable. Changing it breaks cross-device Chrome Sync and OAuth identity.
- Google OAuth client IDs are maintainer configuration (GOOGLE_CLIENT_ID or google-config.json); never reuse another app's client or embed a client secret. Background authorization must remain non-interactive and bound to the original Drive account.
