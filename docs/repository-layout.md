# SB3開発ガイド

この文書は、camera appとfusion appのソースを編集・検証する開発者向けガイドです。アプリ全体の
目的と現在の状態は[README](../README.md)、実行時の責務は[システム構成](architecture.md)を参照して
ください。

`multiview-pose`は2つのTurboWarpアプリを含むpnpm monorepoです。展開済みSB3ソースを正本とし、
生成した`.sb3`を決定的な配布artifactとして扱います。

## ディレクトリ構成

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
config/
  extension-readiness.json
docs/
scripts/
```

各`source/`内の役割:

| path | 内容 |
|---|---|
| `project.source.json` | TurboWarp projectの展開済み正本 |
| `sb3-source.json` | SB3へ収録するproject、asset、entryの指定 |
| `embedded-extensions.json` | SB3に埋め込む検証済み拡張の一覧 |
| `assets/` | costume、soundなどのproject asset |
| `extensions/` | integrityを確認して固定した拡張bundle |

`dist/`のSB3を直接編集して変更を正本にしないでください。変更は`source/`へ反映し、再ビルドします。

## セットアップと検証

workspace rootでexact versionに固定した`@kubohiroya/sb3-toolchain`を使用します。

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`が実行する検査:

1. repository構造とJSONの妥当性
2. text fileの改行・末尾空白
3. Node.js scriptの構文
4. extension readiness inventoryの整合性
5. camera app／fusion appのSB3 source validation
6. 同じsourceから同じarchiveを生成できること
7. 両アプリのSB3 build

個別にも検証・ビルドできます。

```bash
pnpm --filter @multiview-pose/camera-app check
pnpm --filter @multiview-pose/camera-app build
pnpm --filter @multiview-pose/fusion-app check
pnpm --filter @multiview-pose/fusion-app build
```

ローカルではビルド後に`git status --short`と`git diff -- apps/camera-app/dist apps/fusion-app/dist`を
確認し、生成物の差分がソース変更に対応していることをreviewします。CIはclean checkoutで
`git diff --exit-code`を実行し、commit済みソースから生成物が変化しないことを確認します。

## ローカルデータ

会場固有のカメラ選択、calibration draft、pairing code、ICE credential、session IDはcommitしません。
端末固有データは`apps/<app>/local/`または`*.local.json`に保存します。これらのpathはignoreされ、
`project.source.json`から参照してはいけません。

配布SB3の生成前には、一時的な接続情報や個人・会場固有データが`source/`へ混入していないことを
確認します。

## 拡張機能の追加・更新

埋込extensionは、exact npm version、extension ID、artifact SHA-256、block API manifestがreadiness
inventoryを通過してから`source/extensions/`へcopyします。

1. `config/extension-readiness.json`へversion、URL、SHA-256、block contractを記録する。
2. `pnpm check:extensions`でinventoryの整合性を確認する。
3. 必要に応じて`pnpm check:extensions -- --verify-network`で公開bundleとmanifestを照合する。
4. 検証済みbundleを`source/extensions/`へ固定し、独立したreview可能な差分にする。

release build中にextensionを暗黙にdownload／updateしてはいけません。現在の導入可否は
[TurboWarp拡張 readiness](extension-readiness.md)を参照してください。

## ロールバック

最後に検証済みの`.sb3` release artifactを保持します。toolchain更新で想定外の出力差分が生じた場合は、
直前のexact versionへ戻し、commit済みの展開済みソースから再ビルドします。アプリ機能は個別の
既定OFF flagで制御します。repository bootstrap自体にruntime flagはありません。
