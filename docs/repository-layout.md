# repository構成とSB3 workflow

`multiview-pose`は、2つの完成品TurboWarp applicationを含むpnpm monorepoである。展開済みSB3
sourceを正とし、生成した`.sb3`を決定的な配布artifactとする。

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

workspace rootでexact versionに固定した`@kubohiroya/sb3-toolchain`を使用する。`pnpm check`で
両appをvalidate／buildする。個別にも実行できる。

```bash
pnpm --filter @multiview-pose/camera-app check
pnpm --filter @multiview-pose/camera-app build
pnpm --filter @multiview-pose/fusion-app check
pnpm --filter @multiview-pose/fusion-app build
```

会場固有のcamera選択、calibration draft、pairing code、ICE credential、session IDはcommitしない。
端末固有dataは`apps/<app>/local/`または`*.local.json`に保存する。これらのpathはignoreされ、
`project.source.json`から参照してはならない。

埋込extensionは、exact npm version、extension ID、artifact SHA-256、block API manifestがreadiness
inventoryを通過してから`source/extensions/`へcopyする。extension更新は独立したreview可能な差分にする。
release build中にextensionを暗黙にdownload／updateしてはならない。

## rollback

最後に検証済みの`.sb3` release artifactを保持する。toolchain更新で想定外の出力差分が生じた場合は、
直前のexact versionへ戻し、commit済みexpanded sourceから再buildする。application機能は個別の
default-off flagで制御する。repository bootstrap自体にruntime flagはない。
