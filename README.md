# PR #189467 evidence assets (not product code)

Rendered Control UI sidebar over real Gateway rows, plus the gateway runtime /
upgrade replay logs referenced from the PR body and comments.

- `sidebar-collapsed.png`, `sidebar-expanded.png` — real Chromium render of the
  Control UI sidebar connected to a real in-process Gateway (1440x1000 viewport).
- `sidebar-nav-expanded.png` — the sidebar element only, children expanded.
- `sidebar-render-proof.json` — the DOM facts, `sessions.create` requests/responses
  and `sessions.list` rows behind those screenshots.
- `gateway-runtime-proof.txt` — persisted lineage for the pre-patch / patched /
  explicit-fork native payloads.
- `gateway-upgrade-compat-proof.txt` — stable-written populated store re-read
  after a gateway restart, recovery path and patched-build creation.
