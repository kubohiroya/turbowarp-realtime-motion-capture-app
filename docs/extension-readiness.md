# TurboWarp extension readiness

This document is the human-readable companion to
[`config/extension-readiness.json`](../config/extension-readiness.json). It implements the first
development gate in [epic #1](https://github.com/kubohiroya/multiview-pose/issues/1): application
scripts are not built until every required operation is available as a testable TurboWarp block.

## Repository boundary

```text
generic extensions
  camera-source / jsqr / webrtc / yaml-json / asset-manager / aframe
                         |
                         v
turbowarp-multiview-pose
  stable multiview-specific and composite blocks
                         |
                         v
multiview-pose
  camera app.sb3 / fusion app.sb3, built with sb3-toolchain
```

The application repository owns SB3 scripts, performance DSL files, calibration profiles, demo
assets, extension pins, and distribution artifacts. `turbowarp-multiview-pose` owns reusable
multiview-specific behavior, but it does not own either finished application.

## Current readiness

| Role | Package/version | Status | Ready now | Required next work |
|---|---|---|---|---|
| Camera source | `@kubohiroya/turbowarp-camera-source@0.4.0` | Partial | Named camera lifecycle and GPU-backed preview runtime API | [Preview blocks and actual width/height/FPS reporters](https://github.com/kubohiroya/turbowarp-camera-source/issues/8) |
| QR reader | `@kubohiroya/turbowarp-jsqr@0.3.0` | Ready with dependency | Wait, decode, runtime-variable delivery, broadcast | Decide whether to retain the Temporary Variables dependency |
| WebRTC | `@kubohiroya/turbowarp-webrtc@0.2.0` | Partial | LAN offer/answer, state, reliable JSON messages | [Latest-data pose channel, `bufferedAmount`, drop policy, stable capability API](https://github.com/kubohiroya/turbowarp-webrtc/issues/10) |
| DSL values/schema | `@kubohiroya/turbowarp-yaml-json@0.2.0` | Partial | Immutable values, JSON/YAML rendering, JSON Schema validation | [Safely parse externally loaded DSL text](https://github.com/kubohiroya/turbowarp-yaml-json/issues/3) |
| Assets/animation | `@kubohiroya/turbowarp-asset-manager@0.15.0` | Partial | Pinned assets, sprite skins, sounds, actor sequences | [Publish the block API manifest](https://github.com/kubohiroya/turbowarp-asset-manager/issues/116), then confirm the app asset manifest |
| 3D scene | `@kubohiroya/turbowarp-aframe@0.2.0` | Partial | Scene graph and animation blocks | [PoseFrame3D-to-avatar high-level retargeting block](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/4) |
| Diagnostics | `@kubohiroya/turbowarp-diagnostic-overlay@0.3.0` | Partial | Structured stage overlay | [Publish the block API manifest](https://github.com/kubohiroya/turbowarp-diagnostic-overlay/issues/13), then define the app readiness payload |
| Multiview blocks | not released | Missing | Repository and implementation subissues exist | [QR display](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/2), [pose codecs](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/3), [avatar retargeting](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/4), [MoveNet WebGPU](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/5), [calibration](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/6) |

## Gate decisions

### Camera shell

Camera acquisition can start with Camera Source 0.4.0. The application must not add another
`getUserMedia()` call. Before the camera shell is considered complete, GPU preview must be invokable
as a block rather than only through `acquireCamera({preview: true})`.

### QR courier pairing

jsQR and the reliable WebRTC pairing path are available. QR envelope construction, multi-part
reassembly, Version 40 rendering, temporary sprite skin lifecycle, and cleanup remain in
`turbowarp-multiview-pose`. Manual copy/paste pairing remains the rollback path.

### Pose streaming

MoveNet MultiPose must run with the TensorFlow.js WebGPU backend and must reject startup when the
selected backend is not `webgpu`. A CPU, WASM, or WebGL inference fallback is out of scope. The
current WebRTC event block is suitable for control messages but not the final replaceable pose-frame
channel because it has no application-visible backpressure control.

### Fusion and avatar demo

`PoseFrame2D`, `PoseFrame3D`, calibration, session policy, and performance DSL v1 are fixed in child
Issue #5 before retargeting or fusion blocks are implemented. A-Frame stays a generic renderer;
multiview-specific skeleton application belongs in `turbowarp-multiview-pose` unless a reusable
generic rig contract emerges.

## Promotion rule for composite blocks

An SB3 block sequence is promoted into `turbowarp-multiview-pose` only when at least one applies:

- it owns asynchronous cancellation, cleanup, or resource leases;
- it implements a versioned protocol or security boundary;
- the same sequence appears in multiple scripts or both applications;
- intermediate variables make the SB3 flow difficult to audit;
- deterministic unit testing is materially easier in TypeScript.

Simple orchestration and presentation remain visible in the camera/fusion SB3 projects.

## Artifact policy

Every embedded extension is pinned by exact package version and SHA-256 of the JavaScript artifact.
The recorded values are evidence for development; `sb3-toolchain` becomes the enforcing mechanism in
Issue #4. An extension update requires a reviewed API-manifest comparison and a new hash. Pairing
codes, camera frames, and machine-local device IDs are never stored in the expanded SB3 source.

## Rollback

If a required extension does not pass its gate, keep its feature flag off and retain the preceding
artifact pin. Disable features in reverse dependency order: avatar/fusion, pose stream, QR courier,
then preview. The camera lifecycle and manual WebRTC pairing remain independently testable.
