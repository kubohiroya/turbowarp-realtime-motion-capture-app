# TurboWarp Realtime Motion Capture Apps

**English** | [日本語](README.ja.md)

TurboWarp-based applications that estimate the 2D pose of people from several cameras and use the
reconstructed 3D pose to drive a performance. Three SB3s are provided: a `camera app` that runs once
per camera, a `fusion app` that aggregates the results from every camera, and a `local app` that
carries several USB cameras on one PC through to 3D avatars inside a single SB3.

The npm package `turbowarp-realtime-motion-capture-app` distributes the source workspace that makes
these apps reproducibly buildable. It is not a finished library runtime but an application source
package: SB3 sources, pinned extension information, build and verification scripts, a distribution
page, and design documents.

> [!IMPORTANT]
> Development towards v0.1.0 is in progress. Every required TurboWarp extension is pinned to a
> published version and already embedded in the SB3, and the block scripts run from startup through
> camera selection, QR pairing, pose estimation and streaming, and space-time calibration. None of
> that has been verified on real hardware yet. The fusion app shows a VRM avatar per performer from
> the 3D output; skeleton constraints and the avatar performance are not implemented.

## What's included

| Item                                                                                                                                                                                     | Status                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unpacked SB3 sources for the camera app, the fusion app, and the local app                                                                                                               | Available                                                                                                   |
| Deterministic SB3 builds and CI verification                                                                                                                                             | Available                                                                                                   |
| Exact-version pinning of external TurboWarp extensions and embedding into the SB3                                                                                                        | Available                                                                                                   |
| App shell (feature flag setup, loading display, error display, diagnostic reporter)                                                                                                      | Available                                                                                                   |
| Title screen, app menu, DSL file management (Title Menu extension)                                                                                                                       | Available                                                                                                   |
| Startup block scripts (generated from TypeScript)                                                                                                                                        | Available                                                                                                   |
| Block scripts for camera selection, GPU preview, stop, and disconnect monitoring                                                                                                         | Available (not yet verified on real hardware)                                                               |
| Lens calibration entry (restore a saved profile, open the lens calibration app on the same origin in its own window, load a profile file)                                                | Available (not yet verified on real hardware; see [persistence](docs/persistence.md))                       |
| QR pairing (the fusion app projects the offer, the camera app shows the answer, a test message is exchanged once connected)                                                              | Available (not yet verified on real hardware; see [QR pairing](docs/qr-pairing.md))                         |
| MoveNet pose estimation and streaming (the camera app estimates 2D poses with WebGPU MoveNet and sends `PoseFrame2D` to the fusion app over a latest-data channel)                       | Available (not yet verified on real hardware; see [pose streaming](docs/pose-stream.md))                    |
| local app, stage 1: start several cameras, show them side by side, measure delivered fps, remember the arrangement                                                                       | Available (not yet verified on real hardware; see [local app](docs/local-app.md), #36)                      |
| Space-time calibration (the fusion app projects the time pattern, each camera app measures time correspondence and the pattern corners, the fusion app solves placement and gates READY) | Available (not yet verified on real hardware; see [space-time calibration](docs/space-time-calibration.md)) |
| 3D pose service, stage 1 (interface v1, stub service, and the fusion app's forwarding, validation and status; flag `external3dServiceV1` off by default)                                 | Available (stub only; see [3D pose service](docs/pose-3d-service.md), #34)                                  |
| Distribution page offering the three SB3s for download                                                                                                                                   | Available                                                                                                   |
| Avatars in the fusion app (a VRM per performer from the 3D output, up to six; flag `external3dServiceV1`)                                                                                | Available (synthetic data only; see [3D pose service](docs/pose-3d-service.md))                             |
| Skeleton constraints and smoothing (#34 stage 5 and later) and avatar performance (Performance DSL effects)                                                                              | Not implemented                                                                                             |
| Persistence of settings and performance DSL                                                                                                                                              | Decided, not implemented ([Persistence design](docs/persistence.md))                                        |
| Local-host distribution as a single binary                                                                                                                                               | In design ([Local host](docs/local-host.md))                                                                |
| End-to-end verification on venue hardware and the v0.1.0 release                                                                                                                         | Not started                                                                                                 |

The distribution page does not embed the TurboWarp player; it offers each mode's SB3 for download.
Run `pnpm run build:sb3` before downloading from the dev server.

[GitHub Issues](https://github.com/kubohiroya/turbowarp-realtime-motion-capture-app/issues) are the
source of truth for progress. Per-extension readiness is recorded in
[TurboWarp extension readiness](docs/extension-readiness.md) (Japanese).

## Planned

- Implement skeleton constraints and smoothing, and the block scripts that show Performance DSL effects on the avatars.
- Implement persistence for settings and the performance DSL (the design is settled).
- Distribute the local host as a single binary.
- Verify end to end on venue hardware and release v0.1.0.

## Modes

| Mode       | Where it runs                               | Role                                                                                        |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| camera app | A PC connected to a camera (one per camera) | Estimates the 2D pose of up to 6 people from the video and sends only `PoseFrame2D`         |
| fusion app | The fusion PC                               | Aggregates the 2D poses into a 3D pose and drives the avatar and the performance            |
| local app  | A single PC with several USB cameras        | Runs the whole path in one SB3, from the cameras to the 3D avatars, and requires no pairing |

The camera video itself is never sent over the ordinary communication path; it is processed inside
each camera app. The plan is to connect cameras to the fusion app via QR codes as the standard path,
with manual entry as the recovery path. The goal is a configuration that runs at a venue with no
internet connection.

```text
USB camera ─ camera app ─┐
                          ├─ PoseFrame2D ─► fusion app ─► triangulation ─► avatar / stage output
USB camera ─ camera app ─┘
```

Frame alignment, person association, triangulation, and the 3D solve are implemented by
`poseFusion3D` in the higher-level `turbowarp-realtime-motion-capture` extension. This repository is
the application that uses that functionality.

See [System architecture](docs/architecture.md) (Japanese) for the detailed responsibilities and data
flow.

## Dependencies and responsibilities

Each SB3 embeds every extension it needs as a single static bundle. TurboWarp asks for extension
permission only once per app.

| App        | Embedded extensions (in bundle member order)                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| camera app | app shell, Title Menu, Camera Source, jsQR, WebRTC, WebRTC QR Pairing, Time-Space Sync, Realtime Motion Capture, Diagnostic Overlay                                                     |
| fusion app | app shell, Title Menu, Camera Source, jsQR, WebRTC, WebRTC QR Pairing, Time-Space Sync, YAML/JSON, Realtime Motion Capture, Asset Manager, A-Frame, 3D Pose Service, Diagnostic Overlay |
| local app  | app shell, Title Menu, Camera Source, Time-Space Sync, Realtime Motion Capture, 3D Pose Service, Diagnostic Overlay                                                                     |

The app shell comes first deliberately. The Realtime Motion Capture extension fixes its feature flags
at evaluation time, so the flags have to be written before it. See the
[SB3 development guide](docs/repository-layout.md) (Japanese) for details.

Every external extension is pinned by version, artifact, SHA-256, and block contract, and the pinned
state is verified on every run of `pnpm check`. The title screen, the app menu, and DSL file
management are handled by `@kubohiroya/turbowarp-title-menu`. The app shell in this repository only
injects feature flags and provides the loading and error overlays.

## Layout and development

Node.js >=22.18.0, pnpm 11.11.0.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm check` runs, in order: ESLint, Prettier, the type checks, this repository's own tests, the
repository structure and text checks, each workspace package, the generated block scripts, the pinned
state of the embedded extensions, the extension readiness inventory, each app's SB3 source, the
bundle member order, the release snapshot (two builds, compared), and finally the SB3 and page
builds.

- `config/app.json`: name, modes, description, and planned work. English README text goes under `en`.
- `config/feature-flags.ts`: the distribution page's experimental flags, fixed at startup and OFF by
  default.
- `config/app-extensions.json`: the extensions embedded into each SB3, and where they are pinned from.
- `apps/<app>/source`: the unpacked SB3 sources, which are the source of truth for each app.
- `scripts/app-scripts`: the TypeScript that generates the SB3 block scripts.
- `packages/`: the app shell extension, the 3D pose service, the local host, and the SB3 script
  builder.
- `src`: the distribution page built on the shared shell.
- `public/downloads`: the generated SB3s and `release.json`.
- `dist`: build output for the distribution page and downloads.

After changing `scripts/app-scripts` run `pnpm run build:scripts`, and after changing a pinned
extension run `pnpm run pin:extensions`. Generated SB3 files, `public/downloads`, and `dist` are not
tracked by Git. Archives are produced with sb3-toolchain.

To build individually:

```bash
pnpm --filter @turbowarp-realtime-motion-capture-app/app-shell build
pnpm --filter @turbowarp-realtime-motion-capture-app/camera-app build
pnpm --filter @turbowarp-realtime-motion-capture-app/fusion-app build
pnpm --filter @turbowarp-realtime-motion-capture-app/local-app build
```

The artifacts are written to the paths below. None of them is committed to the repository;
`apps/<app>/release.json` records the identity of the source and the SHA-256 of the archive.

- `apps/camera-app/dist/camera-app.sb3`
- `apps/fusion-app/dist/fusion-app.sb3`
- `apps/local-app/dist/local-app.sb3`

For editing the sources and pinning extensions, see the
[SB3 development guide](docs/repository-layout.md) (Japanese).

## Design principles

- Treat the unpacked SB3 sources as the source of truth, and regenerate `.sb3` deterministically.
- Pin external extensions by version, artifact, SHA-256, and block contract.
- Keep experimental features OFF by default, so they can be rolled back one feature at a time.
- Keep device- and venue-specific data, such as session or credential information, out of the
  repository and the distributed SB3s.
- Keep shared protocol definitions in the higher-level extension, and do not reimplement them in this
  app.
- Reject unknown schema versions and malformed payloads before they change any app state.

## Rollback and task management

An application path is stopped by removing its flag from `packages/app-shell/src/apps/` and pinning
the extensions again; the distribution page's own flags live in `config/feature-flags.ts`. Turning a
page flag ON does not implement anything.

GitHub Issues are the source of truth for progress, recording start/done/blocked.

## Documentation

These documents are written in Japanese.

- [System architecture](docs/architecture.md) — runtime structure, data flow, responsibilities, degraded behavior
- [SB3 development guide](docs/repository-layout.md) — directories, editing, building, verification, pinning extensions
- [Inter-app protocol](docs/protocol.md) — the schemas used, and the compatibility and safety policy
- [Persistence design](docs/persistence.md) — saving and restoring the performance DSL and calibration data (decided, not implemented)
- [Local host](docs/local-host.md) — single-binary distribution and venue operation (in design)
- [Measuring on real hardware](docs/measurement.md) — frame rate and capture-to-pose latency, with a measurement build and the recording analyzer (Japanese)
- [TurboWarp extension readiness](docs/extension-readiness.md) — availability of external extensions and the adoption gate
- [Template](docs/template.md) — what this repository takes from turbowarp-app-template, and where it deliberately differs

## Origin

This repository follows [turbowarp-app-template](https://github.com/kubohiroya/turbowarp-app-template).
The template was extracted from the kamishibai (picture-story) app and from this repository, and the
shared structure — `config/app.json`, `config/feature-flags.ts`, the distribution page under `src`,
the SB3 downloads under `public/downloads`, and the `pnpm check` pipeline — was adopted here
afterwards. Where this repository carries three apps, pinned external extensions, and generated block
scripts, it extends the template rather than replacing it; see [Template](docs/template.md)
(Japanese) for the differences.

## License

MPL-2.0.
