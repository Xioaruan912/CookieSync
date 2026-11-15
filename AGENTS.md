# Working conventions

- Use this repository as the only editable source of truth. Do not implement fixes in copied release/build folders.
- Keep the repository source-only: no node_modules, dist, build, .turbo, browser profiles, ZIPs or credentials in the working directory.
- Build and verify with `node scripts/workspace.mjs verify`. Dependencies and intermediate files go to an OS cache outside the repository; release files go to the adjacent `CookieSync-release` directory. `build` skips verification for already-tested source.
- Do not introduce a development auto-reload server or background control connection. Users download the production ZIP, extract it, and load/reload the extension in Chrome.
- Auto push and pull default to enabled for registered sites. Respect explicit user switches; do not enroll every website a user visits.
- Compare semantic SHA-256 fingerprints of plaintext, not ciphertext. Ignore ordering, timestamps and device store IDs. Encryption-policy changes must still rewrite remote data.
- Keep per-destination baselines and preserve pending local data on conflicts. Test in-flight changes, empty reads, individual edits/deletions, and unchanged-data skips.
- WebDAV conditional writes stay enabled by default. AList/OpenList compatibility is explicit opt-in with its non-atomic limitation documented.
- Preserve GitHub Gist, Cloudflare KV, MIT license and upstream attribution. Never log cookie/token values or commit actual credentials.
- Repository destination: https://github.com/Xioaruan912/CookieSync. Preserve upstream and never force-push without explicit instruction.
