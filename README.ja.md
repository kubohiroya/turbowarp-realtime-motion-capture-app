# TurboWarp Realtime Motion Capture Apps

[English](README.md) | **日本語**

複数のカメラで人物の2D姿勢を推定し、復元した3D姿勢を演出に利用する、TurboWarpベースのアプリケーション
です。カメラごとに動かす`camera app`、各カメラの結果を集約する`fusion app`、1台のPCに接続した複数の
USBカメラから3Dアバターまでを1つのSB3で通す`local app`の3つのSB3を提供します。

npm package `turbowarp-realtime-motion-capture-app`は、これらのアプリを再現可能にビルドするための
ソースworkspaceを配布します。完成済みのlibrary runtimeではなく、SB3ソース、固定した拡張情報、
ビルド・検証script、配布ページ、設計文書をまとめたapplication source packageです。

> [!IMPORTANT]
> 現在はv0.1.0に向けた開発中です。必要なTurboWarp拡張はすべて公開版に固定してSB3へ埋め込み済みで、
> 起動からカメラ選択、QRペアリング、姿勢推定と送信、空間と時刻の校正までのblockスクリプトも
> あります。3D統合の出力から演者ごとのVRMアバターを表示できます。ただしいずれも実機確認前で、時間方向の
> 人物同定とアバター演出は未実装です。

## 現在の内容

| 項目                                                                                                                             | 状態                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| camera app／fusion app／local appの展開済みSB3ソース                                                                             | 利用可能                                                                   |
| 決定的なSB3ビルドとCI検証                                                                                                        | 利用可能                                                                   |
| 外部TurboWarp拡張のexact version固定とSB3への埋め込み                                                                            | 利用可能                                                                   |
| アプリシェル（feature flag設定、読み込み表示、エラー表示、診断reporter）                                                         | 利用可能                                                                   |
| タイトル画面、アプリメニュー、DSLファイル管理（Title Menu拡張）                                                                  | 利用可能                                                                   |
| アプリ起動時のblockスクリプト（TypeScriptから生成）                                                                              | 利用可能                                                                   |
| カメラ選択、GPU preview、停止、切断監視のblockスクリプト                                                                         | 利用可能（実機確認前）                                                     |
| レンズ校正の入口（保存済み校正の復元、同じoriginのレンズ校正アプリを別ウィンドウで開く、校正ファイルの読込み）                   | 利用可能（実機確認前。[永続化設計](docs/persistence.md)）                  |
| QRペアリング（fusion appがOfferを投影、camera appがAnswerを表示、接続後にテストメッセージを送受信）                              | 利用可能（実機確認前。[QRペアリング](docs/qr-pairing.md)）                 |
| MoveNet姿勢推定と送信（camera appがWebGPU MoveNetで2D姿勢を推定し、`PoseFrame2D`をlatest-data channelでfusion appへ送る）        | 利用可能（実機確認前。[姿勢推定と送信](docs/pose-stream.md)）              |
| local appの段階1：複数カメラの起動・同時表示・実測fps・構成の保存                                                                | 利用可能（実機確認前。[local-app](docs/local-app.md)、#36）                |
| 空間と時刻の校正（fusion appが時刻パターンを投影し、各camera appが時刻対応と四隅を測定、fusion appが配置をsolveしてREADYを判定） | 利用可能（実機確認前。[空間と時刻の校正](docs/space-time-calibration.md)） |
| 3Dサービス連携の段階1（interface v1、stubサービス、fusion appの転送・検証・状況表示。フラグ`external3dServiceV1`は既定OFF）      | 利用可能（stubのみ。[3Dサービス](docs/pose-3d-service.md)、#34）           |
| 3つのSB3をダウンロードできる配布ページ                                                                                           | 利用可能                                                                   |
| fusion appのアバター表示（3D統合の出力から演者ごとのVRMを最大6体。フラグ`external3dServiceV1`で有効）                            | 利用可能（合成データのみで確認。[3Dサービス](docs/pose-3d-service.md)）    |
| 時間方向の人物同定（#34 段階4以降）、アバター演出（演出DSLのエフェクト）                                                         | 未実装                                                                     |
| 設定・演出DSLの永続化                                                                                                            | 方針確定・未実装（[永続化設計](docs/persistence.md)）                      |
| 単体バイナリでのローカルホスト配布                                                                                               | 設計中（[ローカルホスト](docs/local-host.md)）                             |
| 会場機材でのE2E検証とv0.1.0配布                                                                                                  | 未実施                                                                     |

配布ページはTurboWarpプレイヤーを内蔵せず、各モードのSB3のダウンロードを提供します。開発サーバーで
ダウンロードする際は事前に`pnpm run build:sb3`を実行してください。

進捗の正本は[GitHub Issues](https://github.com/kubohiroya/turbowarp-realtime-motion-capture-app/issues)です。拡張ごとの
準備状況は[TurboWarp拡張 readiness](docs/extension-readiness.md)に記録しています。

## 実装予定

- 時間方向の人物同定と、演出DSLのエフェクトをアバターに表すblockスクリプトを実装する。
- 設定と演出DSLの永続化を実装する（方針は確定済み）。
- ローカルホストを単体バイナリとして配布する。
- 会場機材でE2E検証を行い、v0.1.0を配布する。

## モード

| モード     | 実行場所                               | 役割                                                               |
| ---------- | -------------------------------------- | ------------------------------------------------------------------ |
| camera app | カメラに接続したPC（1カメラにつき1台） | 映像から最大6人の2D姿勢を推定し、`PoseFrame2D`だけを送信する       |
| fusion app | 統合PC                                 | 2D姿勢を集約して3D姿勢へ統合し、アバターと演出を制御する           |
| local app  | 複数のUSBカメラを接続した1台のPC       | カメラから3Dアバターまでを1つのSB3で通す。ペアリングを必要としない |

カメラ映像そのものは通常の通信経路へ流さず、各camera app内で処理します。カメラとfusion appの接続は
QRコードを標準経路、手動入力を復旧経路とする計画です。会場内でインターネット接続なしに運用できる
構成を目標にしています。

```text
USB camera ─ camera app ─┐
                          ├─ PoseFrame2D ─► fusion app ─► triangulation ─► avatar / stage output
USB camera ─ camera app ─┘
```

frame alignment、人物対応付け、triangulation、3D solveは高位拡張`turbowarp-realtime-motion-capture`の
`poseFusion3D`が実装します。本リポジトリはその機能を利用するアプリケーションです。

詳しい責務とデータフローは[システム構成](docs/architecture.md)を参照してください。

## 依存と責務

各SB3は、必要な拡張をすべて1つのstatic bundleとして埋め込みます。TurboWarpでの拡張許可プロンプトは
アプリごとに1回だけです。

| アプリ     | 埋め込む拡張（bundle member順）                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| camera app | app shell、Title Menu、Camera Source、jsQR、WebRTC、WebRTC QR Pairing、Time-Space Sync、Realtime Motion Capture、Diagnostic Overlay                                                     |
| fusion app | app shell、Title Menu、Camera Source、jsQR、WebRTC、WebRTC QR Pairing、Time-Space Sync、YAML/JSON、Realtime Motion Capture、Asset Manager、A-Frame、3D Pose Service、Diagnostic Overlay |
| local app  | app shell、Title Menu、Camera Source、Time-Space Sync、Realtime Motion Capture、3D Pose Service、Diagnostic Overlay                                                                     |

app shellが先頭なのは意図的です。Realtime Motion Capture拡張は評価時にfeature flagを固定するため、それより
先にflagを書き込む必要があります。詳細は[SB3開発ガイド](docs/repository-layout.md)を参照してください。

外部拡張はversion、配布物、SHA-256、block contractで固定し、その状態を`pnpm check`のたびに検証します。
タイトル画面、アプリメニュー、DSLファイルの管理は`@kubohiroya/turbowarp-title-menu`が担当します。
このリポジトリのapp shellは、feature flagの注入と、読み込み・エラーのoverlayだけを持ちます。

## 構成と開発

Node.js >=22.18.0、pnpm 11.11.0。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm check`は、ESLint、Prettier、型検査、本リポジトリ自身のテスト、リポジトリ構造とtext fileの検査、
各workspace package、生成したblockスクリプト、埋め込み拡張の固定状態、拡張readiness inventory、
各アプリのSB3ソース、bundle member順、release snapshot（2回ビルドして比較）、最後にSB3と配布ページの
ビルドを順に実行します。

- `config/app.json`：名前、モード、説明、実装予定。英語READMEの訳文は`en`に置きます。
- `config/feature-flags.ts`：配布ページの実験機能フラグ。起動時固定・既定OFF。
- `config/app-extensions.json`：各SB3へ埋め込む拡張と、その固定元。
- `apps/<app>/source`：展開済みSB3ソース。各アプリの正本です。
- `scripts/app-scripts`：SB3のblockスクリプトを生成するTypeScript。
- `packages/`：app shell拡張、3Dサービス、ローカルホスト、SB3 script builder。
- `src`：共通シェルを利用する配布ページ。
- `public/downloads`：生成SB3と`release.json`。
- `dist`：配布ページとダウンロードのビルド結果。

`scripts/app-scripts`を変更したら`pnpm run build:scripts`、固定した拡張を変更したら
`pnpm run pin:extensions`を実行します。生成SB3、`public/downloads`、`dist`はGit管理対象外です。
アーカイブはsb3-toolchainで生成します。

個別にビルドする場合:

```bash
pnpm --filter @turbowarp-realtime-motion-capture-app/app-shell build
pnpm --filter @turbowarp-realtime-motion-capture-app/camera-app build
pnpm --filter @turbowarp-realtime-motion-capture-app/fusion-app build
pnpm --filter @turbowarp-realtime-motion-capture-app/local-app build
```

生成物は次の場所に出力されます。いずれもリポジトリにはcommitせず、`apps/<app>/release.json`が
ソースのidentityとarchiveのSHA-256を記録します。

- `apps/camera-app/dist/camera-app.sb3`
- `apps/fusion-app/dist/fusion-app.sb3`
- `apps/local-app/dist/local-app.sb3`

ソース編集、拡張の固定方法は[SB3開発ガイド](docs/repository-layout.md)を参照してください。

## 設計上の原則

- SB3の展開済みソースを正本とし、`.sb3`は決定的に再生成する。
- 外部拡張はバージョン、配布物、SHA-256、block contractを固定する。
- 実験的な機能は既定OFFにし、機能単位で切り戻せるようにする。
- セッション情報や認証情報など、端末・会場固有のデータをリポジトリや配布SB3へ含めない。
- 共通protocolの定義は高位拡張側に集約し、このアプリでは再実装しない。
- 未知のschema versionや不正なpayloadは、アプリ状態を変える前に拒否する。

## ロールバックとタスク管理

アプリ側の経路は`packages/app-shell/src/apps/`からflagを外して再ビルドし、
`pnpm run pin:extensions`で埋め込み直すことで止めます。配布ページ自身のフラグは
`config/feature-flags.ts`にあり、ONにしても何かが実装されるわけではありません。

GitHub Issuesを進捗の正本とし、start/done/blockedを記録します。

## ドキュメント

- [システム構成](docs/architecture.md) — 実行構成、データフロー、責務、縮退動作
- [SB3開発ガイド](docs/repository-layout.md) — ディレクトリ、編集、ビルド、検証、拡張の固定
- [アプリ間protocol](docs/protocol.md) — 利用するschemaと互換性・安全性の方針
- [永続化設計](docs/persistence.md) — 演出DSLと校正データの保存・復元（方針確定・未実装）
- [ローカルホスト](docs/local-host.md) — 単体バイナリでの配布と会場運用（設計中）
- [実機での計測](docs/measurement.md) — 計測用ビルドと録画の解析で、毎秒フレーム数と撮影→ポーズの遅延を測る手順
- [TurboWarp拡張 readiness](docs/extension-readiness.md) — 外部拡張の利用可否と導入gate
- [テンプレート](docs/template.md) — turbowarp-app-templateから取り込んだ構成と、意図的に異なる点

## 抽出元

本リポジトリは[turbowarp-app-template](https://github.com/kubohiroya/turbowarp-app-template)に従います。
テンプレート自体は紙芝居アプリと本リポジトリから抽出したもので、共通構成（`config/app.json`、
`config/feature-flags.ts`、`src`の配布ページ、`public/downloads`のSB3、`pnpm check`のパイプライン）を
後からこちらへ取り込みました。3つのアプリ、固定した外部拡張、生成するblockスクリプトは、
テンプレートを置き換えるのではなく拡張したものです。差分は[テンプレート](docs/template.md)を
参照してください。

## ライセンス

MPL-2.0。
