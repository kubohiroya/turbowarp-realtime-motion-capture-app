# TurboWarp Realtime Motion Capture Apps

[English](README.md) | **日本語**

複数のカメラで人物の2D姿勢を推定し、復元した3D姿勢を演出に利用する、TurboWarpベースのアプリケーション
です。カメラごとに動かす`camera app`と、各カメラの結果を集約する`fusion app`の2つのSB3を提供します。

npm package `turbowarp-realtime-motion-capture-app`は、これらのアプリを再現可能にビルドするための
ソースworkspaceを配布します。完成済みのlibrary runtimeではなく、SB3ソース、固定した拡張情報、
ビルド・検証script、設計文書をまとめたapplication source packageです。

> [!IMPORTANT]
> 現在はv0.1.0に向けた開発中です。必要なTurboWarp拡張はすべて公開版に固定してSB3へ埋め込み済みで、
> アプリの起動シェル（画面表示とfeature flag設定）も動作します。ただしSB3のblockスクリプトは未作成
> のため、カメラ取得、ペアリング、姿勢推定、3D統合、アバター表示はまだ利用できません。

## アプリの構成

| アプリ | 実行場所 | 役割 |
|---|---|---|
| camera app | カメラに接続したPC（1カメラにつき1台） | 映像から最大6人の2D姿勢を推定し、`PoseFrame2D`だけを送信する |
| fusion app | 統合PC | 2D姿勢を集約して3D姿勢へ統合し、アバターと演出を制御する |

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

## 現在の実装状況

| 項目 | 状態 |
|---|---|
| camera app／fusion appの展開済みSB3ソース | 利用可能 |
| 決定的なSB3ビルドとCI検証 | 利用可能 |
| 外部TurboWarp拡張のexact version固定とSB3への埋め込み | 利用可能 |
| アプリシェル（feature flag設定、読み込み表示、エラー表示、診断reporter） | 利用可能 |
| タイトル画面、アプリメニュー、DSLファイル管理（Title Menu拡張） | 利用可能 |
| アプリ起動時のblockスクリプト（TypeScriptから生成） | 利用可能 |
| カメラ選択、GPU preview、停止、切断監視のblockスクリプト | 利用可能（実機確認前） |
| レンズ校正の入口（保存済み校正の復元、同じoriginのレンズ校正アプリを別ウィンドウで開く、校正ファイルの読込み） | 利用可能（実機確認前。[永続化設計](docs/persistence.md)） |
| QRペアリング（fusion appがOfferを投影、camera appがAnswerを表示、接続後にテストメッセージを送受信） | 利用可能（実機確認前。[QRペアリング](docs/qr-pairing.md)） |
| MoveNet姿勢推定と送信（camera appがWebGPU MoveNetで2D姿勢を推定し、`PoseFrame2D`をlatest-data channelでfusion appへ送る） | 利用可能（実機確認前。[姿勢推定と送信](docs/pose-stream.md)） |
| local-app（1台のPCで複数USBカメラから3Dアバターまで通すスタンドアロン版）の段階1：複数カメラの起動・同時表示・実測fps・構成の保存 | 利用可能（実機確認前。[local-app](docs/local-app.md)、#36） |
| 空間と時刻の校正（fusion appが時刻パターンを投影し、各camera appが時刻対応と四隅を測定、fusion appが配置をsolveしてREADYを判定） | 利用可能（実機確認前。[空間と時刻の校正](docs/space-time-calibration.md)） |
| 3Dサービス連携の段階1（interface v1、stubサービス、fusion appの転送・検証・状況表示。フラグ`external3dServiceV1`は既定OFF） | 利用可能（stubのみ。[3Dサービス](docs/pose-3d-service.md)、#34） |
| 3D推定の本体、アバター演出のblockスクリプト | 未実装 |
| 設定・演出DSLの永続化 | 方針確定・未実装（[永続化設計](docs/persistence.md)） |
| 単体バイナリでのローカルホスト配布 | 設計中（[ローカルホスト](docs/local-host.md)） |
| 会場機材でのE2E検証とv0.1.0配布 | 未実施 |

進捗の正本は[GitHub Issues](https://github.com/kubohiroya/turbowarp-realtime-motion-capture-app/issues)です。拡張ごとの
準備状況は[TurboWarp拡張 readiness](docs/extension-readiness.md)に記録しています。

## 配布SB3の中身

各SB3は、必要な拡張をすべて1つのstatic bundleとして埋め込みます。TurboWarpでの拡張許可プロンプトは
アプリごとに1回だけです。

| アプリ | 埋め込む拡張（bundle member順） |
|---|---|
| camera app | app shell、Title Menu、Camera Source、jsQR、WebRTC、Realtime Motion Capture、Diagnostic Overlay |
| fusion app | app shell、Title Menu、WebRTC、YAML/JSON、Realtime Motion Capture、Asset Manager、A-Frame、Diagnostic Overlay |

app shellが先頭なのは意図的です。Realtime Motion Capture拡張は評価時にfeature flagを固定するため、それより
先にflagを書き込む必要があります。詳細は[SB3開発ガイド](docs/repository-layout.md)を参照してください。

タイトル画面、アプリメニュー、DSLファイルの管理は`@kubohiroya/turbowarp-title-menu`が担当します。
このリポジトリのapp shellは、feature flagの注入と、読み込み・エラーのoverlayだけを持ちます。

## 開発環境のセットアップ

必要なもの:

- Node.js 22.13.0以上
- pnpm 11.11.0

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`はリポジトリ構造、書式、スクリプト構文、拡張inventory、各workspace packageの検査、
埋め込み拡張の固定状態、決定的ビルドを順に検証し、最後にSB3を再生成します。

個別にビルドする場合:

```bash
pnpm --filter @turbowarp-realtime-motion-capture-app/app-shell build
pnpm --filter @turbowarp-realtime-motion-capture-app/camera-app build
pnpm --filter @turbowarp-realtime-motion-capture-app/fusion-app build
```

生成物は次の場所に出力されます。どちらもリポジトリにはcommitせず、`apps/<app>/release.json`が
ソースのidentityとarchiveのSHA-256を記録します。

- `apps/camera-app/dist/camera-app.sb3`
- `apps/fusion-app/dist/fusion-app.sb3`

現段階のSB3はTurboWarpで開けて拡張のblockも使えますが、アプリ固有のスクリプトが未作成のため、
カメラシステムとしては動作しません。ソース編集、拡張の固定方法は
[SB3開発ガイド](docs/repository-layout.md)を参照してください。

## 設計上の原則

- SB3の展開済みソースを正本とし、`.sb3`は決定的に再生成する。
- 外部拡張はバージョン、配布物、SHA-256、block contractを固定する。
- 実験的な機能は既定OFFにし、機能単位で切り戻せるようにする。
- セッション情報や認証情報など、端末・会場固有のデータをリポジトリや配布SB3へ含めない。
- 共通protocolの定義は高位拡張側に集約し、このアプリでは再実装しない。
- 未知のschema versionや不正なpayloadは、アプリ状態を変える前に拒否する。

## ドキュメント

- [システム構成](docs/architecture.md) — 実行構成、データフロー、責務、縮退動作
- [SB3開発ガイド](docs/repository-layout.md) — ディレクトリ、編集、ビルド、検証、拡張の固定
- [アプリ間protocol](docs/protocol.md) — 利用するschemaと互換性・安全性の方針
- [永続化設計](docs/persistence.md) — 演出DSLと校正データの保存・復元（方針確定・未実装）
- [ローカルホスト](docs/local-host.md) — 単体バイナリでの配布と会場運用（設計中）
- [TurboWarp拡張 readiness](docs/extension-readiness.md) — 外部拡張の利用可否と導入gate
