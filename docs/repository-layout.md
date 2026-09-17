# SB3開発ガイド

この文書は、camera app、fusion app、local appのソースを編集・検証する開発者向けガイドです。アプリ
全体の目的と現在の状態は[README](../README.md)、実行時の責務は[システム構成](architecture.md)、
turbowarp-app-templateとの関係は[テンプレート](template.md)を参照してください。

`turbowarp-realtime-motion-capture-app`は3つのTurboWarpアプリ、アプリシェル拡張、配布ページを含む
pnpm monorepoです。展開済みSB3ソースを正本とし、生成した`.sb3`を決定的な配布artifactとして扱います。
リポジトリ全体の骨格はturbowarp-app-templateに合わせています。

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
    release.json
    dist/camera-app.sb3（ignore）
  fusion-app/
    source/...
    release.json
    dist/fusion-app.sb3（ignore）
  local-app/
    source/...
    release.json
    dist/local-app.sb3（ignore）
packages/
  app-shell/            アプリ所有のTurboWarp拡張（feature flagと画面）
  local-host/           ローカルホストの部品（[ローカルホスト](local-host.md)）
  pose-3d-service/      3Dサービスのinterfaceとstub（[3Dサービス](pose-3d-service.md)）
  sb3-script/           SB3のblock列を組み立てる
config/
  app.json                   名前、モード、説明、実装予定（英語訳は`en`）
  feature-flags.ts           配布ページの実験機能フラグ（起動時固定・既定OFF）
  app-extensions.json        各SB3へ埋め込む拡張の宣言
  local-host.json            ローカルホストの固定port（[ローカルホスト](local-host.md)）
  extension-requirements.json readinessの要求定義（手で編集する）
  extension-readiness.json    生成物（手で編集しない）
docs/
index.html                   配布ページのentry
src/                         配布ページ（`@kubohiroya/turbowarp-app-shell`を使う）
public/downloads/            配布ページが配るSB3と`release.json`（生成物・ignore）
tests/                       ルート側のテスト（vitest）
scripts/                     TypeScriptで書き、`node scripts/<name>.ts`で直接実行する
```

`config/app.json`から`src`、`tests`、READMEが同じモード定義を読みます。アプリを増減するときは、
`apps/`と`config/app-extensions.json`に加えてここも更新します。`tests/distribution-page.test.ts`が
両者の食い違いを検出します。

各`source/`内の役割:

| path                       | 内容                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `project.source.json`      | TurboWarp projectの展開済み正本。`blocks`、`extensions`、`extensionURLs`は生成される |
| `sb3-source.json`          | SB3へ収録するproject、asset、entryの指定                                             |
| `embedded-extensions.json` | 埋め込む拡張、その固定元、static bundleの構成。生成される                            |
| `assets/`                  | costume、soundなどのproject asset                                                    |
| `extensions/`              | 固定した拡張bundleとAPI manifest。生成される                                         |

`extensions/*.js`はcommitしません。`node_modules`の固定versionと`packages/app-shell`のビルド出力から
再生成でき、合計27 MBに達するためです。代わりに、その`.js`のSHA-256を`embedded-extensions.json`が、
block APIを`extensions/*.manifest.json`が記録し、どちらもcommitします。つまりreviewできる形で
固定されたまま、リポジトリには大きなbundleが入りません。

`pnpm check`と各アプリの`check`／`build`は、実行の最初に`.js`を再生成します。cloneして
`pnpm install`した直後でも、追加の手順なしにビルドできます。

`dist/`のSB3を直接編集して変更を正本にしないでください。変更は`source/`へ反映し、再ビルドします。

`dist/`もcommitしません。生成物が1つ6 MBあり、ソースを1行変えるたびに同じ量が積まれるためです。
代わりに`apps/<app>/release.json`が、展開済みソース全体のidentityと、そこから生成されるarchiveの
SHA-256・サイズを記録し、これをcommitします。`pnpm run check:release`はSB3を2回ビルドして、決定性、ソース
identityの一致、記録したSHA-256との一致を検証します。ソースを意図して変えたときは
`pnpm run snapshot`で記録を更新します。

## セットアップと検証

workspace rootでexact versionに固定した`@kubohiroya/sb3-toolchain`を使用します。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm check`が実行する検査:

1. ESLint（`config`、`scripts`、`src`、`tests`、ビルド設定）
2. Prettier（生成物を除く全ファイル）
3. repository scriptとworkspace packageの型検査
4. ルート側のテスト（`tests/`、vitest）
5. repository構造とJSONの妥当性、text fileの改行・末尾空白
6. `packages/`の検査（typecheck、test、build）
7. 生成したblockスクリプトと`scripts/app-scripts`の一致
8. 埋め込み拡張の再生成と、commit済みの固定内容との一致
9. extension readiness inventoryの生成一致と整合性
10. 各アプリのSB3ソース検査
11. 生成されたstatic bundleのmember評価順が宣言どおりで、feature flagが契約拡張より先に書かれること
12. release snapshotの検証（2回ビルドしての決定性、ソースidentity、記録したSHA-256）
13. 3つのアプリのSB3 buildと、配布ページのbuild

`pnpm dev`は配布ページの開発サーバーを起動します。ページはSB3を`public/downloads/`から配るため、
先に`pnpm run build:sb3`を実行しておきます。

個別にも検証・ビルドできます。

```bash
pnpm --filter @turbowarp-realtime-motion-capture-app/app-shell check
pnpm --filter @turbowarp-realtime-motion-capture-app/camera-app check
pnpm --filter @turbowarp-realtime-motion-capture-app/camera-app build
```

ローカルではビルド後に`git status --short`と`git diff -- apps/*/release.json`を確認し、記録された
SHA-256の変化がソース変更に対応していることをreviewします。CIはclean checkoutで
`git diff --exit-code`を実行し、commit済みソースから生成物と記録が変化しないことを確認します。

## アプリシェル拡張

`packages/app-shell`はcamera app用、fusion app用、local app用の3つのTurboWarp拡張bundleをビルドします。

```bash
pnpm --filter @turbowarp-realtime-motion-capture-app/app-shell build
# packages/app-shell/dist/camera-app/camera-app-shell.js
# packages/app-shell/dist/fusion-app/fusion-app-shell.js
# packages/app-shell/dist/local-app/local-app-shell.js
```

このシェルが持つのは、feature flagの注入と、読み込み・エラーのoverlayだけです。タイトル画面、
アプリメニュー、DSLファイル管理は`@kubohiroya/turbowarp-title-menu`が担当し、bundleの2番目の
memberとして入ります。

シェルは`turbowarp-realtime-motion-capture`が読む`globalThis.__TWMP_FEATURE_FLAGS__`を書き込みます。
契約拡張はモジュール評価時にflagを固定するため、**シェルは必ずbundleの先頭member**でなければ
なりません。`scripts/pin-embedded-extensions.ts`はこの順序を強制し、先頭が`workspace` providerで
なければビルドを失敗させます。さらに`scripts/check-bundle-order.ts`が、生成されたbundleの中で
実際にshellのソースが契約拡張より前へ置かれていることを確認します。

flagの適用結果は実行時にも`feature flag state`reporterで確認できます。`applied`以外なら、
bundleの並び順が壊れています。

有効にするflagは`packages/app-shell/src/apps/`で宣言します。機能を切り戻すときはここからflagを
外して再ビルドし、`pnpm run pin:extensions`で埋め込み直します。アプリメニューの項目はSB3側で
`add app menu action`により登録するので、ここには書きません。

## アプリのスクリプト

SB3のblock列は`scripts/app-scripts/`のTypeScriptを正本とし、`pnpm run build:scripts`で
`project.source.json`の`blocks`へ生成します。

```ts
script({ x: 48, y: 48 }, [
  block('event_whenflagclicked'),
  block(`${shell}_showAppLoading`, {
    LABEL: text('カメラアプリを起動しています'),
  }),
  block(`${cameraSource}_refreshCameraDevices`),
  block(`${shell}_hideAppLoading`),
  block(`${titleMenu}_showTitle`),
]);
```

idで相互参照する平坦なblock mapは、diffを見ても何が変わったか分かりません。読む対象は上のコードで、
block mapは生成物です。idは`s<script番号>b<block番号>`で位置から決まるので、無関係な編集で他の
スクリプトが振り直されることもありません。

opcodeは各拡張が公開しているそのままの名前を書きます。static bundleの名前空間付与はビルドが行うため、
ソースは拡張のドキュメントと突き合わせて読めます。

`packages/sb3-script/src/standard.ts`には、条件分岐、反復、待機、broadcast、variable／list操作など、
アプリscriptで実際に使用するScratch標準blockの薄いwrapperがあります。C blockのbodyはsubstackとして
親子関係と`next`を自動生成します。variable、list、broadcastは表示名だけで参照せず、展開済みsourceの
IDを含む`NamedReference`を渡します。これによりsender、receiver、data blockが同じentityを安定して
参照できます。

camera appは最初のcamera取得でbrowser permissionを要求し、許可後に再列挙した最大8 deviceをapp menuへ
登録します。選択したdeviceは`pose`というnamed cameraで保持し、previewと後続のMoveNet consumerが同じ
streamを共有します。明示停止前のtrack終了は0.5秒間隔で検出し、permission拒否、device未検出、実行中の
切断、WebGPU API未対応を別のdiagnostic codeとして表示します。

## 配布ページ

`index.html`と`src/`は、各アプリのSB3を配るページです。TurboWarpプレイヤーは内蔵せず、モードを選ぶと
その役割とSB3のダウンロードを表示します。文言とモードの定義は`config/app.json`が正本で、ページ自身の
実験機能フラグは`config/feature-flags.ts`にあります（起動時固定・既定OFF）。

```bash
pnpm run build:sb3   # 各アプリをビルドし、public/downloads/へ集めてrelease.jsonを書く
pnpm dev             # 配布ページの開発サーバー
pnpm build           # build:sb3のあとページをdist/へビルドする
```

`scripts/build-downloads.ts`は`apps/<app>/dist/<app>.sb3`をコピーするだけで、SB3を別に作り直しません。
配るファイルはアプリがビルドしたものと同一で、`public/downloads/release.json`がそのSHA-256とサイズを
記録します。

## 会場向けバイナリ

```bash
pnpm build && pnpm run build:player && pnpm run build:binary
```

`build:player`はSB3を`@turbowarp/packager`で自己完結HTMLへ変換し、`build:binary`がそれを同梱した
単体バイナリを`bun build --compile`で生成します。生成物は`apps/<app>/dist/`に出るためcommitしません。
bunはPATHに要求し、リポジトリの依存にはしていません。詳細は[ローカルホスト](local-host.md)を参照して
ください。

## ローカルデータ

会場固有のカメラ選択、calibration draft、pairing code、ICE credential、session IDはcommitしません。
端末固有データは`apps/<app>/local/`または`*.local.json`に保存します。これらのpathはignoreされ、
`project.source.json`から参照してはいけません。実行時の保存先の方針は
[永続化設計](persistence.md)を参照してください。

配布SB3の生成前には、一時的な接続情報や個人・会場固有データが`source/`へ混入していないことを
確認します。

## 拡張機能の追加・更新

埋め込み拡張は`config/app-extensions.json`で宣言し、スクリプトで固定します。`source/extensions/`と
`embedded-extensions.json`、`project.source.json`の`extensions`／`extensionURLs`は生成物です。
手で編集しないでください。

1. 対象アプリの`package.json`へexact versionのnpm依存を追加する。
2. `pnpm install`で`node_modules`へ取り込む。
3. `config/app-extensions.json`へextension ID、package、artifact path、API manifest pathを宣言する。
4. `pnpm run pin:extensions`でJavaScriptとmanifestをcopyし、SHA-256を記録する。commit対象の
   ファイルを書き換えるのはこの`--write`付きの実行だけで、`pnpm check`が呼ぶ検査側は、生成物が
   commit済みの内容と一致しない場合に失敗する。
5. `pnpm run update:readiness`でreadiness inventoryを再生成する。
6. `node scripts/check-extension-readiness.ts --verify-network`で公開bundleと照合する。
7. `pnpm check`で全体を検証し、生成された差分を独立したreview可能なcommitにする。

release build中にextensionを暗黙にdownload／updateしてはいけません。現在の導入可否は
[TurboWarp拡張 readiness](extension-readiness.md)を参照してください。

## static bundleについて

各アプリは埋め込んだ拡張を1つのstatic bundleへまとめます。TurboWarpの拡張許可プロンプトが
アプリごとに1回になり、bundle memberの評価順が宣言順に固定されます。bundleの構成は
`embedded-extensions.json`の`extensionBundles`にあり、これも`config/app-extensions.json`から
生成されます。

生成されたSB3では、blockのopcodeに`<memberId>__`が付きます。展開済みソース側のopcodeは元のまま
なので、ソースを読むときはbundle前の名前で読みます。

## ロールバック

最後に検証済みのrelease snapshotを保持します。SB3そのものはreleaseに添付し、リポジトリには
置きません。toolchain更新で想定外の出力差分が生じた場合は、
直前のexact versionへ戻し、commit済みの展開済みソースから再ビルドします。アプリ機能はapp shellの
feature flag宣言で制御します。
