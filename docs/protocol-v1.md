# multiview-pose protocol v1

The protocol package is the single source of truth for data exchanged or persisted by camera app
and fusion app. TypeScript types are derived from the same TypeBox definitions that generate the
JSON Schema files under `packages/protocol/schemas/`.

Every payload carries a stable `schema` identifier and literal `version: 1`. Unknown versions,
unknown fields, missing required fields, unsafe numeric ranges, and oversized collections are
rejected before application state changes.

| Contract | Schema identifier | Purpose |
|---|---|---|
| Session policy | `twmp/session-policy` | Session topology and operational limits; never pairing credentials |
| Camera calibration | `twmp/camera-calibration` | Image geometry, intrinsics, distortion and camera-to-world transform |
| PoseFrame2D | `twmp/pose-frame-2d` | Up to six tracked people with ordered COCO-17 image keypoints |
| PoseFrame3D | `twmp/pose-frame-3d` | Up to six fused people, contributing cameras and reprojection quality |
| Clock probe | `twmp/clock-probe` | Versioned ping/pong timestamps for offset and RTT estimation |
| Performance DSL | `twmp/performance-dsl` | Up to six performers and their color, start/end effects and avatar asset |

Pairing offers, answers, ICE credentials, and QR courier parts are transient protocol data. They are
not members of session policy or performance DSL and must not be written to persistent app settings.

The v1 parser is fail-closed. A future version is rejected until its schema and explicit application
support are added. On validation failure, session start and 3D output stop; the committed v1 parser
and last valid calibration remain the rollback path.
