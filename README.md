# multiview-pose

複数のカメラで人物の2D姿勢を推定し、復元した3D姿勢を演出に利用する、TurboWarpベースのアプリケーション
です。カメラごとに動かす`camera app`と、各カメラの結果を集約する`fusion app`の2つのSB3を提供します。

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

frame alignment、人物対応付け、triangulation、3D solveは高位拡張`turbowarp-multiview-pose`の
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
| カメラ取得、QRペアリング、MoveNet姿勢推定のblockスクリプト | 未実装 |
| 複数視点の校正、3D統合、アバター演出のblockスクリプト | 未実装 |
| 設定・演出DSLの永続化 | 方針確定・未実装（[永続化設計](docs/persistence.md)） |
| 単体バイナリでのローカルホスト配布 | 設計中（[ローカルホスト](docs/local-host.md)） |
| 会場機材でのE2E検証とv0.1.0配布 | 未実施 |

進捗の正本は[GitHub Issues](https://github.com/kubohiroya/multiview-pose/issues)です。拡張ごとの
準備状況は[TurboWarp拡張 readiness](docs/extension-readiness.md)に記録しています。

## 配布SB3の中身

各SB3は、必要な拡張をすべて1つのstatic bundleとして埋め込みます。TurboWarpでの拡張許可プロンプトは
アプリごとに1回だけです。

| アプリ | 埋め込む拡張（bundle member順） |
|---|---|
| camera app | app shell、Title Menu、Camera Source、jsQR、WebRTC、Multiview Pose、Diagnostic Overlay |
| fusion app | app shell、Title Menu、WebRTC、YAML/JSON、Multiview Pose、Asset Manager、A-Frame、Diagnostic Overlay |

app shellが先頭なのは意図的です。Multiview Pose拡張は評価時にfeature flagを固定するため、それより
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
pnpm --filter @multiview-pose/app-shell build
pnpm --filter @multiview-pose/camera-app build
pnpm --filter @multiview-pose/fusion-app build
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
