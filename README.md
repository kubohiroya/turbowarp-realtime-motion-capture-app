# multiview-pose

複数のカメラで人物の2D姿勢を推定し、外部3Dサービスで復元した3D姿勢を演出に利用する、
TurboWarpベースのアプリケーションです。カメラごとに動かす`camera app`と、各カメラの結果および
外部3Dサービスとの通信を集約する`fusion app`の2つのSB3を提供します。

> [!IMPORTANT]
> 現在はv0.1.0に向けた開発初期段階です。リポジトリには再現可能なSB3ビルド基盤のみがあり、
> カメラ取得、ペアリング、姿勢推定、3D統合、アバター表示はまだ利用できません。
> `dist/`のSB3も動作確認用の空のアプリシェルです。

## アプリの構成

| アプリ | 実行場所 | 役割 |
|---|---|---|
| camera app | カメラに接続したPC（1カメラにつき1台） | 映像から最大6人の2D姿勢を推定し、`PoseFrame2D`だけを送信する |
| fusion app | 統合PC | 2D姿勢を外部3Dサービスへ中継し、返された3D姿勢でアバターと演出を制御する |

カメラ映像そのものは通常の通信経路へ流さず、各camera app内で処理します。カメラとfusion appの接続は
QRコードを標準経路、手動入力を復旧経路とする計画です。会場内でインターネット接続なしに運用できる
構成を目標にしています。

```text
USB camera ─ camera app ─┐                 ┌────────────┐  PoseFrame2D  ┌─────────────────────┐
                          ├─ PoseFrame2D ─►│ fusion app ├──────────────►│ external 3D service │
USB camera ─ camera app ─┘                 │            │◄──────────────┤                     │
                                           └──────┬─────┘  PoseFrame3D  └─────────────────────┘
                                                  ▼
                                          avatar / stage output
```

詳しい責務とデータフローは[システム構成](docs/architecture.md)を参照してください。

## 現在の実装状況

| 項目 | 状態 |
|---|---|
| camera app／fusion appの展開済みSB3ソース | 利用可能 |
| 決定的なSB3ビルドとCI検証 | 利用可能 |
| 外部TurboWarp拡張の要件・候補管理 | 調査中 |
| カメラ取得、QRペアリング、MoveNet姿勢推定 | 未実装 |
| 複数視点の校正、外部3Dサービス連携、アバター演出 | 未実装 |
| 会場機材でのE2E検証とv0.1.0配布 | 未実施 |

進捗の正本は[GitHub Issues](https://github.com/kubohiroya/multiview-pose/issues)です。実装前の
拡張機能ごとの準備状況は[TurboWarp拡張 readiness](docs/extension-readiness.md)に記録しています。

## 開発環境のセットアップ

必要なもの:

- Node.js 22.13.0以上
- pnpm 11.11.0

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`はリポジトリ構造、書式、スクリプト構文、拡張機能inventory、両アプリのソース、
決定的ビルドを順に検証し、最後にSB3を再生成します。

個別にビルドする場合:

```bash
pnpm --filter @multiview-pose/camera-app build
pnpm --filter @multiview-pose/fusion-app build
```

生成物は次の場所に出力されます。

- `apps/camera-app/dist/camera-app.sb3`
- `apps/fusion-app/dist/fusion-app.sb3`

現段階のSB3はTurboWarpで開けますが、空のアプリシェルであり、カメラシステムとしては動作しません。
ソース編集、ローカル設定、拡張機能の固定方法は[SB3開発ガイド](docs/repository-layout.md)を参照してください。

## 設計上の原則

- SB3の展開済みソースを正本とし、`.sb3`は決定的に再生成する。
- 外部拡張はバージョン、配布物、SHA-256、block contractを固定する。
- 実験的な機能は既定OFFにし、機能単位で切り戻せるようにする。
- セッション情報や認証情報など、端末・会場固有のデータをリポジトリや配布SB3へ含めない。
- 共通protocolの定義は高位拡張側に集約し、このアプリでは再実装しない。
- 未知のschema versionや不正なpayloadは、アプリ状態を変える前に拒否する。

## ドキュメント

- [システム構成](docs/architecture.md) — 実行構成、データフロー、責務、縮退動作
- [SB3開発ガイド](docs/repository-layout.md) — ディレクトリ、編集、ビルド、検証、ローカルデータ
- [アプリ間protocol](docs/protocol.md) — 利用するschemaと互換性・安全性の方針
- [TurboWarp拡張 readiness](docs/extension-readiness.md) — 外部拡張の利用可否と導入gate
