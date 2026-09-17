# TurboWarp Realtime Motion Capture Apps

**English** | [日本語](README.ja.md)

TurboWarp-based applications that estimate the 2D pose of people from several cameras and use the
reconstructed 3D pose to drive a performance. Two SB3s are provided: a `camera app` that runs once per
camera, and a `fusion app` that aggregates the results from every camera.

The npm package `turbowarp-realtime-motion-capture-app` distributes the source workspace that makes these
apps reproducibly buildable. It is not a finished library runtime but an application source package: SB3
sources, pinned extension information, build and verification scripts, and design documents.

> [!IMPORTANT]
> Development towards v0.1.0 is in progress. Every required TurboWarp extension is pinned to a published
> version and already embedded in the SB3, and the app startup shell (screen display and feature flag
> setup) works. However, the SB3 block scripts have not been written yet, so camera capture, pairing,
> pose estimation, 3D fusion, and avatar display are not available.

## App structure

| App | Where it runs | Role |
|---|---|---|
| camera app | A PC connected to a camera (one per camera) | Estimates the 2D pose of up to 6 people from the video and sends only `PoseFrame2D` |
| fusion app | The fusion PC | Aggregates the 2D poses into a 3D pose and drives the avatar and the performance |

The camera video itself is never sent over the ordinary communication path; it is processed inside each
camera app. The plan is to connect cameras to the fusion app via QR codes as the standard path, with
manual entry as the recovery path. The goal is a configuration that runs at a venue with no internet
connection.

```text
USB camera ─ camera app ─┐
                          ├─ PoseFrame2D ─► fusion app ─► triangulation ─► avatar / stage output
USB camera ─ camera app ─┘
```

Frame alignment, person association, triangulation, and the 3D solve are implemented by `poseFusion3D` in
the higher-level `turbowarp-realtime-motion-capture` extension. This repository is the application that
uses that functionality.

See [System architecture](docs/architecture.md) (Japanese) for the detailed responsibilities and data flow.

## Current implementation status

| Item | Status |
|---|---|
| Unpacked SB3 sources for the camera app and fusion app | Available |
| Deterministic SB3 builds and CI verification | Available |
| Exact-version pinning of external TurboWarp extensions and embedding into the SB3 | Available |
| App shell (feature flag setup, loading display, error display, diagnostic reporter) | Available |
| Title screen, app menu, DSL file management (Title Menu extension) | Available |
| Startup block scripts (generated from TypeScript) | Available |
| Block scripts for camera selection, GPU preview, stop, and disconnect monitoring | Available (not yet verified on real hardware) |
| Lens calibration entry (restore a saved profile, open the lens calibration app on the same origin in its own window, load a profile file) | Available (not yet verified on real hardware; see [persistence](docs/persistence.md)) |
| Block scripts for QR pairing and MoveNet pose estimation | Not implemented |
| Block scripts for multi-view calibration, 3D fusion, and avatar performance | Not implemented |
| Persistence of settings and performance DSL | Decided, not implemented ([Persistence design](docs/persistence.md)) |
| Local-host distribution as a single binary | In design ([Local host](docs/local-host.md)) |
| End-to-end verification on venue hardware and the v0.1.0 release | Not started |

[GitHub Issues](https://github.com/kubohiroya/turbowarp-realtime-motion-capture-app/issues) are the source
of truth for progress. Per-extension readiness is recorded in
[TurboWarp extension readiness](docs/extension-readiness.md) (Japanese).

## What the distributed SB3s contain

Each SB3 embeds every extension it needs as a single static bundle. TurboWarp asks for extension
permission only once per app.

| App | Embedded extensions (in bundle member order) |
|---|---|
| camera app | app shell, Title Menu, Camera Source, jsQR, WebRTC, Realtime Motion Capture, Diagnostic Overlay |
| fusion app | app shell, Title Menu, WebRTC, YAML/JSON, Realtime Motion Capture, Asset Manager, A-Frame, Diagnostic Overlay |

The app shell comes first deliberately. The Realtime Motion Capture extension fixes its feature flags at
evaluation time, so the flags have to be written before it. See the
[SB3 development guide](docs/repository-layout.md) (Japanese) for details.

The title screen, the app menu, and DSL file management are handled by
`@kubohiroya/turbowarp-title-menu`. The app shell in this repository only injects feature flags and
provides the loading and error overlays.

## Setting up a development environment

Requirements:

- Node.js 22.13.0 or later
- pnpm 11.11.0

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` verifies, in order, the repository structure, formatting, script syntax, the extension
inventory, each workspace package, the pinned state of the embedded extensions, and the deterministic
build, then regenerates the SB3s at the end.

To build individually:

```bash
pnpm --filter @turbowarp-realtime-motion-capture-app/app-shell build
pnpm --filter @turbowarp-realtime-motion-capture-app/camera-app build
pnpm --filter @turbowarp-realtime-motion-capture-app/fusion-app build
```

The artifacts are written to the paths below. Neither is committed to the repository;
`apps/<app>/release.json` records the identity of the source and the SHA-256 of the archive.

- `apps/camera-app/dist/camera-app.sb3`
- `apps/fusion-app/dist/fusion-app.sb3`

The SB3s at this stage open in TurboWarp and their extension blocks work, but because the app-specific
scripts have not been written, they do not yet function as a camera system. For editing the sources and
pinning extensions, see the [SB3 development guide](docs/repository-layout.md) (Japanese).

## Design principles

- Treat the unpacked SB3 sources as the source of truth, and regenerate `.sb3` deterministically.
- Pin external extensions by version, artifact, SHA-256, and block contract.
- Keep experimental features OFF by default, so they can be rolled back one feature at a time.
- Keep device- and venue-specific data, such as session or credential information, out of the repository
  and the distributed SB3s.
- Keep shared protocol definitions in the higher-level extension, and do not reimplement them in this app.
- Reject unknown schema versions and malformed payloads before they change any app state.

## Documentation

These documents are written in Japanese.

- [System architecture](docs/architecture.md) — runtime structure, data flow, responsibilities, degraded behavior
- [SB3 development guide](docs/repository-layout.md) — directories, editing, building, verification, pinning extensions
- [Inter-app protocol](docs/protocol.md) — the schemas used, and the compatibility and safety policy
- [Persistence design](docs/persistence.md) — saving and restoring the performance DSL and calibration data (decided, not implemented)
- [Local host](docs/local-host.md) — single-binary distribution and venue operation (in design)
- [TurboWarp extension readiness](docs/extension-readiness.md) — availability of external extensions and the adoption gate
