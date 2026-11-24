# Canvas Planner: notes for Claude

A task tracker that is mostly an infinite canvas. Task cards **grow** as they age and as their due date approaches. Sync goes through a private GitHub repo. Tasks can be imported from Microsoft To Do, pasted lists, or CSV.

The owner runs it as a **portable app with no installer** on a locked-down work laptop. They are not a developer: explain things plainly, and give the exact clicks.

## Stack
- **Tauri v2**: Rust shell plus the system web engine (WebView2 on Windows, WKWebView on macOS).
- **Frontend:** plain HTML/CSS/vanilla JS ES modules in `src/`. There's **no bundler and no npm runtime deps**. Tauri serves `src/` directly (`frontendDist: ../src`).
- **Builds:** GitHub Actions (`.github/workflows/build.yml`) builds a portable `CanvasPlanner.exe` (Windows, `tauri build --no-bundle`) and a universal `Canvas Planner.app` (zipped). Every push to `main` produces workflow artifacts. A `v*` tag also publishes a GitHub Release.

## Layout
| Path | What |
|---|---|
| `src/js/main.js` | Core: camera (pan/zoom), card rendering, side panel, keyboard, and the `app` API that feature modules plug into. Also at `window.canvasPlanner` for devtools. |
| `src/js/store.js` | Board data + persistence. Board = `{version, tasks[], deleted{id: isoTime}}`. `deleted` holds tombstones for sync. |
| `src/js/growth.js` | The growth formula. Tweak the `GROWTH` constants to change how fast cards grow. |
| `src/js/sync.js`, `sync-merge.js` | GitHub sync (REST contents API via webview `fetch`), with a task-level merge by `updatedAt` plus tombstones. See `docs/SYNC.md`. |
| `src/js/importer.js`, `import-parse.js` | Import: paste, CSV, and Microsoft To Do (Graph, device-code sign-in via the Tauri HTTP plugin). See `docs/IMPORT.md`. |
| `src/js/extras.js` | Search, shortcuts help, and Settings/About, including **Copy diagnostics**. |
| `src-tauri/src/main.rs` | Rust commands: `load_board`/`save_board` (atomic write + backup), `data_folder`, `secret_get/set/delete` (OS keychain via `keyring`). |
| `src-tauri/capabilities/default.json` | Permissions. The HTTP plugin is restricted to api.github.com, login.microsoftonline.com and graph.microsoft.com. |
| `tests/*.test.mjs` | Node tests for pure logic: `node tests/<file>`. |

Feature modules load at the end of `start()` in main.js with `import()`. If one fails, the canvas still works and a warning goes to the console.

## Where data lives
- **Board:** `board.json` in the app data folder:
  - Windows: `%APPDATA%\com.canvasplanner.desktop\`
  - macOS: `~/Library/Application Support/com.canvasplanner.desktop/`
- **Backup:** `board.backup.json` (the previous good save) sits next to it. An unreadable file is renamed to `board.unreadable-<ts>.json`, not deleted.
- **Per-device preferences** (camera position, hide-done, sync repo settings): webview localStorage.
- **Secrets** (GitHub token, Microsoft refresh token): the OS keychain (Windows Credential Manager / macOS Keychain), under the service name `canvas-planner`.

## Diagnosing problems on the work machine
1. In the app, open the gear button → **Copy diagnostics** and ask the user to paste the result. It includes the version, OS, data folder, loaded modules and recent errors.
2. **Phase 0 already passed** on the work laptop (2026-11-24): the unsigned exe launches, file save and keychain work, and api.github.com, login.microsoftonline.com and graph.microsoft.com are reachable *from the webview*.
3. **Known risk:** Microsoft sign-in uses the Tauri HTTP plugin (Rust `reqwest`), not the webview, to avoid CORS. reqwest may **not use the Windows system proxy**. If To Do sign-in fails with a network error but GitHub sync works, that's the likely cause. Options: set the `HTTPS_PROXY` env var, or switch that call to webview fetch if Microsoft allows CORS for it.
4. **The devtools are disabled** in release builds. For debugging, build a debug exe (`npx tauri build --debug --no-bundle`); right-click → Inspect then works.
5. To run in a normal browser without Tauri: serve `src/` with any static server (e.g. `python -m http.server -d src`). Storage and secrets fall back to localStorage, and Microsoft import won't work (CORS).

## Dev commands
- `npm install` (just the Tauri CLI), then `npx tauri dev` to run, or `npx tauri build` to build. Needs Rust.
- Pure logic tests: `node tests/sync-merge.test.mjs`, `node tests/import-parse.test.mjs`.

## Conventions
- Keep it dependency-free on the frontend.
- New features go in their own module with `init(app)`. Extend the `app` API in main.js rather than reaching into internals.
- Never store tokens anywhere but `app.secrets`.
