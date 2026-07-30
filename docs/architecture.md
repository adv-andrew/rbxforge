# RbxForge architecture

## Standalone desktop boundary

RbxForge is a macOS-first Electron application with a React renderer. It is not an IDE and does not import
the legacy VS Code activation, commands, documents, `SecretStorage`, `WorkspaceEdit`, tree providers, or
webview host.

The Electron main process owns SQLite, filesystem identity, native dialogs, clipboard and shell adapters,
child processes, Rojo supervision, the Studio MCP client/broker, plugin installation, binding coordination,
IPC, and window lifecycle. Startup acquires the single-instance lock before `app.whenReady()`. Only after
Electron is ready does it open and migrate SQLite, compose the production services, register IPC, and create
the main window.

The renderer has `nodeIntegration: false`, `contextIsolation: true`, sandboxing enabled, blocked navigation
and window creation, and a narrow schema-validated preload API. It cannot access Node globals, arbitrary
files, environment variables, SQLite, child processes, or MCP directly. Main, preload, shared protocol, and
renderer are separate strict TypeScript domains. A single nonce per build or development launch is shared by
the Electron content-security policy and Vite's nonce-bearing HTML.

The standalone MVP constructs no AI provider or agent loop. It stores user chat entries locally but makes no
model request. It exposes no Studio mutation, playtest, publishing, asset upload, Rojo syncback, or autonomous
write command.

## Runtime topology

```text
React renderer
  ↕ validated preload/IPC
Electron main → SQLite at app.getPath("userData")/rbxforge.sqlite
  ├─ ProjectRuntimeRegistry → one retained `rojo serve` child per active project
  │                           on an OS-assigned 127.0.0.1 port
  ├─ Transactional broker provider → one shared retained Studio MCP broker
  │                                  primary 127.0.0.1:58741 by default
  │                                  optional legacy 127.0.0.1:3002 status
  └─ BindingCoordinator → explicit project + Rojo lease + Studio identity binding

Selected Studio window
  ├─ bundled Studio MCP plugin → shared primary MCP listener
  └─ separate Rojo Studio plugin → manually connected to that project's shown Rojo port
```

The primary MCP port is preflighted and accepted only after the owned child reports primary mode on the
requested loopback address. A collision on the primary port is fatal; RbxForge neither adopts the occupant
nor relies on upstream proxy mode. Pinned upstream MCP also attempts legacy loopback port `3002`. That
secondary listener may be unavailable without failing the primary broker and is shown only in technical
details for troubleshooting.

The broker receives a random per-launch `ROBLOX_STUDIO_AUTH_TOKEN` through its environment. The renderer and
database never receive it. The host communicates with the vendored MCP process over an owned session and
injects the explicitly selected `instance_id` into routed calls. One shared broker can catalog distinct
Studio places; each active project owns a distinct Rojo child and generation-bearing lease. RbxForge stops
only exact child handles retained during the current app lifetime, never a persisted PID, scanned port, or
process name.

The user must manually connect the selected Studio window's Rojo plugin to the project-specific shown port.
Rojo provides no per-window attachment observation to RbxForge, so the recorded handoff is a user
confirmation, not proof.

When protocol projection is unavailable, RbxForge starts Rojo's watched absolute-sourcemap fallback with a
new temporary output path. The production adapter watches that path's parent directory before the child has
necessarily created the file, retries the initial read within a five-second bound, remains abort-aware, and
retains a pending change version across iterator yields so an early filesystem notification is not lost.

## Identity, eligibility, and freshness

Raw ports, PIDs, place names, and MCP instance IDs are display metadata rather than sufficient identity:

| Boundary | Identity captured by the host                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project  | Project ID, canonical root and project-file paths, device/inode pairs, configuration SHA-256, and project revision                                           |
| Rojo     | Opaque lease ID, project ID/revision, lease generation, actual loopback port, and start time                                                                 |
| Studio   | Broker epoch, instance ID, connection time, place ID, role, plugin variant/version, server version, activity time, catalog observation, and catalog revision |
| Binding  | Opaque binding ID/revision plus the complete project, Rojo, and Studio references and the manual handoff confirmation time                                   |

A Studio row is eligible only from the latest validated catalog when it is fresh, has `role === "edit"`,
uses `pluginVariant === "main"`, has `pluginVersion === serverVersion === "2.22.5"`, and reports no version
mismatch. The user must select it explicitly; RbxForge never auto-selects the only row. Declared nonzero
`servePlaceIds` must match. Place ID `0` and projects with no declared place ID require a warning
confirmation. One Studio connection can belong to only one project's write-capable lease during an app
session.

Every connection-dependent operation reasserts the binding revision, project revision, Rojo generation,
broker epoch, Studio connection time, and catalog revision. An old raw instance ID cannot revive a binding
after a broker restart because its broker epoch and connection time differ.

While a connection flow or binding exists, the Studio catalog refreshes every two seconds. The last
successful catalog observation and selected instance activity must each be no more than five seconds old.
Three consecutive refresh failures, six seconds without a fresh observation, application sleep/resume, a
missing or reconnected instance, broker exit, or broker replacement changes the project to **Needs
reconnect** before further connection-dependent use.

For each active runtime, RbxForge watches the project file's parent directory and reopens and rehashes the
exact file every two seconds. Before a connection-dependent host operation it synchronously revalidates the
canonical path, device, inode, and SHA-256. Deletion, unreadability, symlink replacement, inode replacement,
or content change increments the project revision and invalidates the binding. Rojo exit or lease
replacement also invalidates it. If a persisted project directory was moved, deleted, or unmounted before
launch, watcher creation fails closed for that project into **Needs reconnect** with an inert lease instead
of aborting the rest of application startup.

The same-published-place limitation is deliberately outside this identity model. Upstream MCP canonicalizes
edit windows as `place:<placeId>` and normally hides a rejected second registration. Users must keep one
Studio edit window open per published place; RbxForge cannot infer ambiguity that the public catalog does
not expose.

## Persistence and ownership

The versioned SQLite database enables WAL mode and foreign keys and runs migrations transactionally before
the window is shown. It persists projects, threads, messages, drafts, selected rows, the chosen Rojo
executable, preferred MCP port, sidebar width, and validated window bounds. Bounds are restored only when
finite and at least `960 × 640`; otherwise the app opens at `1280 × 800`.

Live connection state is session-owned. RbxForge does not persist a connected flag, active port, PID, Rojo
lease, broker epoch, Studio identity, binding revision, handoff confirmation, approval, or capability.
Previously observed place metadata may be only a non-authoritative suggestion. Relaunch restores local
project/chat state and marks runtime connections for reconnection.

Removing a project stops only its retained Rojo child and deletes only its local database rows. It does not
delete the selected folder or Roblox files. The standalone MVP performs project/configuration discovery reads
and local database/plugin-install writes; it does not mutate a Studio DataModel, property, script, asset, or
place.

## Local trust model

The app is for a trusted, local, same-user workstation. Runtime listeners bind to `127.0.0.1`, processes use
argument arrays with `shell: false`, diagnostics are bounded/redacted, and owned process handles are disposed
gracefully with a bounded force fallback.

The MCP token protects the upstream management and MCP-over-HTTP endpoints, but upstream plugin polling and
registration routes are not token-authenticated. A catalog entry is therefore reported by the plugin, not
cryptographic attestation of Roblox Studio. A malicious process running as the same OS user can also access
the user's files, application data, loopback services, and launch environment. RbxForge does not claim a
hardened hostile-user boundary.

## Electron fuses and signing

The Darwin arm64 package pins `@electron/fuses` and records the inspected fuse wire. Its deliberate states
are:

- `RunAsNode`: **enabled**. The vendored Studio MCP and anchored plugin-installer helper require the packaged
  Electron executable with `ELECTRON_RUN_AS_NODE=1`. This also means the same local user can invoke that
  packaged executable as Node; it is an accepted local developer-tool tradeoff.
- `EnableNodeOptionsEnvironmentVariable`: **disabled**, so `NODE_OPTIONS` cannot alter packaged startup.
- `EnableNodeCliInspectArguments`: **enabled**. The accepted Playwright Electron smoke and visual harness use
  `--inspect=0`. Exposing CLI inspection to the same local user is another explicit developer-tool tradeoff,
  not hostile-user hardening.
- `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`: **enabled** after the curated renderer and
  native SQLite smoke pass.
- `EnableCookieEncryption`: **enabled**.
- `LoadBrowserProcessSpecificV8Snapshot`: **disabled** because the stock Electron distribution does not ship
  the corresponding browser-only snapshot.
- `GrantFileProtocolExtraPrivileges`: **enabled** because the packaged renderer intentionally loads from
  `file://` inside `app.asar`.

Fuse mutation invalidates the prior signature, so packaging re-applies and verifies an ad-hoc Apple Silicon
signature. “Unsigned” means there is no Apple Developer ID/team signature and no notarization; it does not
mean the package lacks that ad-hoc integrity signature.

## Build and packaged paths

Development paths resolve from `app.getAppPath()/dist`. In the packaged app, main, preload, renderer, the
curated `better-sqlite3` JavaScript loader, license, and notices are inside `app.asar`; native SQLite is the
single unpacked Darwin arm64 binary; MCP and plugin assets are outside ASAR under
`process.resourcesPath/vendor`.

```text
RbxForge.app/Contents/Resources/
├── app.asar
│   ├── dist/main/index.cjs
│   ├── dist/preload/index.cjs
│   ├── dist/renderer/**
│   ├── node_modules/better-sqlite3/{package.json,LICENSE,lib/**}
│   ├── package.json
│   ├── LICENSE
│   └── THIRD_PARTY_NOTICES
├── app.asar.unpacked/
│   └── node_modules/better-sqlite3/prebuilds/darwin-arm64.node
└── vendor/
    ├── robloxstudio-mcp/index.mjs
    ├── robloxstudio-mcp/assets/Baseplate.rbxl
    └── studio-plugin/MCPPlugin.rbxmx
```

The packaged runtime paths are:

- renderer: `app.getAppPath()/dist/renderer/index.html`;
- preload: `app.getAppPath()/dist/preload/index.cjs`;
- database: `app.getPath("userData")/rbxforge.sqlite`;
- MCP: `process.resourcesPath/vendor/robloxstudio-mcp/index.mjs`;
- plugin source: `process.resourcesPath/vendor/studio-plugin/MCPPlugin.rbxmx`.

The build bundles the production main entry, sandbox-compatible preload, and relative-base Vite renderer
without source maps. It retains exact module inventories, generates notices from those inventories, and
rejects VS Code, OpenAI, fixture activation, credentials, absolute workspace paths, and unexpected network
endpoints. Ignored external build metadata records exact paths, byte counts, and SHA-256 values for the
main/preload/renderer outputs; staging and final inspection compare against that out-of-band result, and the
manifest itself is not packaged. The `better-sqlite3` JavaScript loader is likewise a closed, pinned 23-file
path/size/digest inventory, with all other JavaScript, native, WASM, and executable-mode entries rejected.

A second ignored external manifest closes the entire `Contents` tree. It is derived before packaging from
the exact pinned Electron 43.2.0 source tree plus the curated icon, native SQLite, and vendor inputs—not from
the output app being inspected. Inspection independently regenerates the trusted manifest from those inputs
and compares the ignored JSON to it before using the regenerated object; the external file is evidence, not
authority. The Electron source itself is pinned by a canonical, mode-aware whole-tree evidence digest. Final
inspection requires exact POSIX permission bits for the `Contents` root and every directory, regular file,
and symlink, plus exact symlink targets; byte-checks every immutable Electron locale/framework resource and
curated resource; validates the changed app/helper plists, architecture, and fuses through their dedicated
gates; and scans retained text and names for credentials and workspace paths. Arbitrary non-executable files
and permission drift therefore fail closed just like native payloads.

Ad-hoc signing is not content authority. The nine Electron executables that legitimately change signature
bytes during packaging retain a source-derived, domain-separated canonical arm64 Mach-O code digest. The
canonicalizer validates the thin arm64 load-command and `__LINKEDIT` layout, excludes only the trailing code
signature and its derived size fields, and explicitly applies the audited version-1 fuse wire to the pinned
Electron Framework source before deriving its expected digest. The packaged bytes are checked without
undoing fuses. All other executable/native payloads remain raw exact-SHA inputs, while
`codesign --verify --deep --strict` remains an additional bundle-integrity gate.

Packaging audits the pinned MCP/plugin/assets and Darwin arm64 SQLite prebuild, inspects the whole
app/ASAR/resources/fuses/architecture/Info.plist/signature, runs the real packaged window and MCP smoke, then
verifies and read-only mounts the DMG. Every mounted app entry, permission mode, and regular-file digest must
be byte-identical to the inspected source app before the DMG is copied to `outputs/`.

## Legacy VS Code architecture

`apps/extension` remains an independent migration reference and regression target. Its VS Code facade owns
commands, documents, workspace edits, `SecretStorage`, tree/webview providers, and the earlier
approval-gated Agent/Studio mutation surfaces. Its extension-host and webview bundles, fixture paths, AI
provider, and VSIX metadata are excluded from the standalone desktop build.

The legacy extension and desktop packagers share the audited `@chrrxs/robloxstudio-mcp` inputs and notice
logic, but otherwise have separate runtime composition and allowlists. Desktop packaging inlines the pinned
MCP version because package metadata is not retained beside that external vendor entry. The legacy Node 20
extension bundle deliberately keeps the prior package lookup and is byte-checked against its pre-desktop
baseline. Extension-only capabilities must not be interpreted as standalone features.
