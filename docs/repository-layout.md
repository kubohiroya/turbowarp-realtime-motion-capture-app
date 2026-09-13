# Repository layout and SB3 workflow

`multiview-pose` is a pnpm monorepo containing two finished TurboWarp applications. Expanded SB3
sources are authoritative; generated `.sb3` files are deterministic distribution artifacts.

```text
apps/
  camera-app/
    source/
      project.source.json
      sb3-source.json
      embedded-extensions.json
      assets/
      extensions/
    dist/camera-app.sb3
  fusion-app/
    source/...
    dist/fusion-app.sb3
```

Use the exact `@kubohiroya/sb3-toolchain` version pinned at the workspace root. Validate and build
both applications with `pnpm check`. Each app can also be handled independently:

```bash
pnpm --filter @multiview-pose/camera-app check
pnpm --filter @multiview-pose/camera-app build
pnpm --filter @multiview-pose/fusion-app check
pnpm --filter @multiview-pose/fusion-app build
```

Do not commit venue-specific camera selections, calibration drafts, pairing codes, ICE credentials,
or session IDs. Store workstation-specific data under `apps/<app>/local/` or in `*.local.json`.
Those paths are ignored and must never be referenced by `project.source.json`.

Embedded extensions are copied into `source/extensions/` only after their exact npm version,
extension ID, artifact SHA-256, and block API manifest pass the readiness inventory. Updates are
separate reviewable changes. A release build never downloads or updates extensions implicitly.

## Rollback

Keep the last verified `.sb3` release artifact. If a toolchain update changes output unexpectedly,
restore the preceding exact version and rebuild from the committed expanded source. Application
features use separate default-off flags; repository bootstrap itself has no runtime flag.
