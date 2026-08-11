# Web UI

The v0.2 UI is built with React/Vite and served by the loopback Supervisor at `/app/`. Run `npm run build`, then `infraenv webui [environment-id]`.

## Available

- Environment and Preset overview.
- Builder for a derived/custom S2 definition.
- Instance list and model lifecycle.
- Aggregated topology, metrics, boot events, Checkpoints, and staged reconcile.
- Manual Trash restore/purge.
- Offline and Direct Runtime fallbacks that do not invent data.
- In Direct Runtime course mode, the left rail is generated from the versioned Lab steps, state is refreshed every five seconds, and only Scenario-allowlisted fault inject/clear actions are enabled.

## Authentication

The CLI requests an origin-bound, one-time launch token. The token stays in the URL fragment, is consumed once, and becomes an HttpOnly SameSite cookie. Browser mutations also require same-origin and CSRF. The browser never receives the Supervisor bearer token or Docker control.

## Disabled panels

Terminal attach, persistent Workspace, external S3 connect/load, generic Playground fault injection, and Placement remain visible only to explain the roadmap. They are enabled only if the active Instance advertises the matching capability; the current Supervisor does not. This does not disable the fixed course Runtime's narrower allowlisted fault controls.

Selecting a catalog Preset in the editable Builder records `DERIVED / CUSTOM from ...`. It does not claim an arbitrary edited topology is the exact NVIDIA reference architecture.

The Direct Runtime fallback can show the fixed course state, canonical Lab steps, allowlisted faults, and pause/resume/reset actions. It cannot manage Environments, Docker Instances, storage, or terminals.
