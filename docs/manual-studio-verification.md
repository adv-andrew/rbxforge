# Manual Roblox Studio verification

Automated package evidence and live Roblox Studio evidence are separate gates. Do not mark a live item
complete from a unit fixture, a running process, an MCP `initialize`/`listTools` response, a renderer
screenshot, or a packaged onboarding window.

## Automated evidence

The following commands do not require a live Studio session:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build:desktop
pnpm --filter @rbxforge/desktop test:visual
pnpm package:desktop
pnpm inspect:desktop
pnpm smoke:desktop
```

They are designed to fail unless the desktop bundles and package satisfy their contracts, including:

- the production main entry opens/migrates a fresh SQLite database, composes the real controller and
  adapters, creates the `1280 × 800` onboarding window, exposes only the preload API, and reports no renderer
  console or page errors;
- the deterministic visual fixture exercises the real renderer, preload, IPC, protocol, and Inspector
  component route at `960 × 640`, `1280 × 800`, and `1440 × 900`, including lazy expansion, Properties,
  responsive geometry, and accessibility; its schema-valid fixture responses are not live Studio evidence;
- main/preload/renderer inventories contain no source maps, fixtures, VS Code runtime, OpenAI provider, auth
  token value, workspace absolute path, or unexpected network endpoint;
- the exact ASAR main/preload/renderer inventory matches the external retained build paths, sizes, and
  digests; the exact 23-file SQLite loader, unpacked native module, notices, license, MCP entry, Baseplate,
  and Studio plugin match their closed allowlists and audited digests;
- the exact whole `Contents` directory/file/symlink inventory matches an external manifest derived from the
  pinned Electron source and curated inputs that inspection independently regenerates; the `Contents` root
  and every entry retain exact POSIX permission bits; immutable Electron locales/framework resources, the app
  icon, native module, and vendor resources match their retained digests; and injected ordinary JS/JSON,
  credential data, unexpected icons, path/type changes, and any permission drift fail closed;
- all nine signature-mutated Electron Mach-O executables match source-derived canonical code digests,
  including the explicitly expected Electron Framework fuse mutation; valid ad-hoc re-signing cannot make a
  same-path substituted executable pass, and signature verification remains a separate gate;
- the single native dependency is the pinned Darwin arm64 `better-sqlite3` prebuild and actually opens SQLite
  under packaged Electron;
- the executable is arm64, the expected fuses are recorded, `NODE_OPTIONS` is disabled, the ad-hoc signature
  verifies, and packaged RunAsNode and CLI-inspection-dependent smoke paths work;
- the packaged MCP entry completes an actual `initialize` and `listTools` session without a live Studio
  connection;
- the DMG passes `hdiutil verify`, mounts read-only, matches every inspected app entry, exact permission mode,
  and regular-file digest byte-for-byte, and unmounts before the handoff copy.

These checks prove package composition and local harness behavior. They do not prove plugin registration,
Studio catalog accuracy, manual Rojo-window attachment, or live Roblox behavior.

## Live Studio environment record

Before checking live behavior, record:

- [ ] RbxForge version and DMG SHA-256.
- [ ] macOS version and Apple Silicon model.
- [ ] Rojo CLI path and exact version (`>=7.7.0 <8.0.0`).
- [ ] Roblox Studio version.
- [ ] bundled MCP server/plugin version and installed `MCPPlugin.rbxmx` SHA-256.
- [ ] selected project root, exact `.project.json`/`.project.jsonc` file, and configuration digest shown by
      RbxForge.
- [ ] published place IDs/names used, with confirmation that only one edit window is open for each published
      place.
- [ ] timestamps plus screenshots or screen recordings for each completed scenario.

## Live standalone checklist

### Installation and first connection

- [ ] Open the unsigned/unnotarized app through Finder **Open** or **Privacy & Security → Open Anyway** and
      confirm the standalone RbxForge window launches without disabling Gatekeeper globally.
- [ ] Add a folder containing one valid `.project.json` or `.project.jsonc`; when multiple candidates exist,
      select the intended project file and confirm its canonical path/digest are shown.
- [ ] With the Studio MCP plugin absent, choose **Install Studio plugin** and confirm the app shows the
      bundled source and `~/Documents/Roblox/Plugins/MCPPlugin.rbxmx` destination. Restart Studio.
- [ ] If a different `MCPPlugin.rbxmx` is present, confirm replacement requires consent and leaves a
      timestamped backup. If `MCPInspectorPlugin.rbxmx` is present, confirm RbxForge blocks readiness and
      offers **Show Plugins folder** without deleting it.
- [ ] Enable **Allow HTTP Requests** in **Game Settings → Security** and keep only the matching main plugin
      variant enabled.
- [ ] Connect using the primary loopback endpoint shown by RbxForge, normally
      `http://127.0.0.1:58741`. Confirm connection details label `58741` as primary and show port `3002` only
      as legacy troubleshooting status.
- [ ] Occupy primary port `58741` in a controlled test, then confirm RbxForge reports a collision and neither
      adopts the process nor silently falls back to proxy/legacy mode. Release it before continuing.

### Project, Rojo, and Studio identity

- [ ] Start the selected project connection and confirm RbxForge reports a distinct app-owned Rojo server at
      the exact shown `127.0.0.1:<port>`.
- [ ] In the intended Studio edit window, manually connect the separate Rojo Studio plugin to that exact port
      and check **I connected this Studio window to the Rojo server above**.
- [ ] Confirm the UI says this checkbox records a manual handoff and does not claim RbxForge observed which
      Studio window attached.
- [ ] Open two different published places and confirm RbxForge lists their place ID, role, plugin/server
      versions, and activity separately and requires an explicit radio selection.
- [ ] Select a fresh, matching, edit-role place and choose **Bind Studio**. Confirm the header names the exact
      place, primary MCP port, and project-specific Rojo server port.
- [ ] Present a wrong-place-only catalog for a project with a declared nonzero `servePlaceIds` value and
      confirm RbxForge blocks the mismatch instead of auto-selecting it.
- [ ] For an unpublished place (`placeId: 0`) or a project with no known place ID, confirm a warning
      acknowledgement is required each app session.
- [ ] Confirm the connection sheet states that only one Studio edit window may be open per published place.
      Do not treat a single visible catalog row as proof that no duplicate window exists.

### Read-only Studio Inspector

- [ ] With a fresh **Studio bound** identity, choose **Inspect Studio** and confirm the Explorer loads the
      expected top-level services from that exact place. The synthetic `game` root stays hidden, and unrelated
      branches must remain unloaded until you expand them.
- [ ] Expand `Workspace`, then one nested container in a disposable place. Confirm each branch loads only
      after its disclosure control is used and that the displayed names, classes, and hierarchy match the
      bound Studio window.
- [ ] Select a known object and confirm Properties shows its class, canonical DataModel path, observation
      timestamp, and expected bounded values. Confirm the panel contains no editable property controls,
      source view, apply action, or Studio-selection action.
- [ ] Disconnect or close the bound Studio place while the Inspector is open. Confirm the old tree and
      Properties disappear, the Inspector closes or reports the connection change, and stale retry/refresh
      actions cannot restore the prior binding.
- [ ] Open two different published places containing deliberately unique object names. Bind the first place
      and confirm the Inspector returns only its marker; then explicitly bind the second and confirm only the
      second marker appears. Record each place ID, instance ID, binding revision, and screenshot. Do not run
      this as a same-published-place test, because that upstream ambiguity remains undetectable.

### Freshness, isolation, and restart

- [ ] Connect two projects concurrently and confirm they have different Rojo ports while sharing one primary
      MCP broker. Switching the selected sidebar project must not retarget or reuse the other binding.
- [ ] Disconnect one project and confirm only its retained Rojo child stops; the other project's runtime
      remains intact.
- [ ] Close or disconnect the selected Studio place and confirm the project changes to **Needs reconnect**
      and connection-dependent actions fail closed.
- [ ] Stop an app-owned Rojo process and confirm its project binding invalidates without stopping unrelated
      processes.
- [ ] Modify, atomically replace, delete, or symlink-replace the selected project file in a disposable
      project and confirm the project revision changes and the old binding cannot be used.
- [ ] Sleep and resume the Mac while bound, or interrupt catalog refresh long enough to cross the documented
      freshness bound, and confirm reconnection is required.
- [ ] Restart RbxForge and confirm projects, threads, messages, drafts, and selected rows return, while live
      Rojo ports, MCP broker identity, and Studio bindings do not.

### Product-boundary checks

- [ ] Confirm the standalone app never asks for an AI provider, API key, login, or model. Saving a prompt
      stores it locally and does not display a fabricated assistant response.
- [ ] Exercise project selection, connection, binding, disconnect, chat storage, and restart; confirm these
      standalone actions do not mutate Studio objects, properties, scripts, assets, or place state.
- [ ] Confirm no screen says that the Rojo Studio plugin attachment was verified. A ready Rojo process plus a
      user handoff confirmation is the strongest available evidence.

## Evidence and result

For each checked item, record the timestamp, exact project/place identity, expected and observed result, and
supporting screenshot or log. Record failures and retries rather than converting them into passes.

Report the two conclusions separately:

```text
Automated desktop/package evidence: PASS | FAIL | NOT RUN
Live Roblox Studio verification:    PASS | FAIL | PARTIAL | NOT RUN
```

The standalone release is not live-Studio verified unless every applicable live item has direct evidence.
Legacy VSIX fixture, Agent, mutation, playtest, and syncback checks are separate extension-only work and do not
satisfy this checklist.
