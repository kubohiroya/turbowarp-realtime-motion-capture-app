# システム構成

## 目的と対象範囲

`multiview-pose`は、複数視点の映像から得た2D人物姿勢を会場内ネットワークで集約し、外部3Dサービスが
復元した3D姿勢を演出用アバターへ反映するTurboWarpアプリケーションです。このリポジトリは完成品の
camera appとfusion app、そのアプリ固有スクリプト、設定、演出DSL、デモasset、配布SB3を所有します。

汎用的なカメラ、QR、WebRTC、データ変換、3D表示の機能は個別のTurboWarp拡張が所有します。
複数拡張にまたがる処理のうち、SB3のblock列では安全な管理が難しいものだけを高位拡張
`turbowarp-multiview-pose`へ集約します。

## 実行構成

初期リリースでは、2つのcamera appと1つのfusion appを有線LAN上で動かし、fusion appから外部3D
サービスを利用する構成を基準にします。外部3Dサービスは別projectが所有し、本リポジトリには
実装しません。

```text
source PC A                 integration PC                    external 3D service
┌──────────────────────┐   ┌────────────────────────┐        ┌────────────────────┐
│ camera → camera app  ├─┐ │ fusion app             │ frames │ alignment / history│
└──────────────────────┘ ├►│  ・2D姿勢の集約・転送  ├───────►│ triangulation       │
source PC B              │ │  ・3D姿勢の受信        │◄───────┤ 3D solve           │
┌──────────────────────┐ │ │  ・avatar／演出        │  pose  └────────────────────┘
│ camera → camera app  ├─┘ └───────────┬────────────┘
└──────────────────────┘               │
                                       ▼
                               projector / display
```

映像はcamera appの端末内に留め、ネットワークへは時刻付きの2D keypointと診断情報を送ります。
デバッグ映像が将来必要になった場合も、通常の姿勢送信とは分離した任意経路として扱います。

## 起動から停止までの流れ

以下はv0.1.0の目標フローです。現時点では未実装です。

1. fusion appがセッションを作成し、接続用QRコードを表示する。
2. 各camera appがカメラを選択し、映像と実際の解像度・FPSを確認する。
3. camera appがQRコードを読み取り、fusion appとのDataChannelを確立する。
4. fusion appがsession policyとcalibration参照を配布する。
5. 各camera appがWebGPU版MoveNet MultiPoseで2D姿勢を推定する。
6. camera appが最新の`PoseFrame2D`を送り、遅延した古いframeは蓄積しない。
7. fusion appが`PoseFrame2D`を外部3Dサービスへ転送する。
8. 外部3Dサービスがframe alignment、履歴、人物対応、triangulation、3D solveを行う。
9. fusion appが返された`PoseFrame3D`をconsumerへ渡し、performance DSLに従って表示を更新する。
10. 終了時は推論、通信、カメラの順に停止し、一時的な接続情報を破棄する。

## アプリと拡張の責務

| 領域 | camera app | fusion app | TurboWarp拡張 | 外部3Dサービス |
|---|---|---|---|---|
| 画面と操作フロー | カメラ選択、preview、状態表示 | セッション、校正、演出、readiness表示 | 再利用可能なblockとruntime処理 | なし |
| カメラ映像 | 端末内で取得・推論 | 受信しない | camera lifecycleとGPU入力 | 受信しない |
| 通信 | 2D姿勢と診断を送信 | policy送信、2D姿勢の集約・転送、3D姿勢の受信 | QR courier、WebRTC channel、backpressure | 2D姿勢の受信、3D姿勢の返信 |
| データ契約 | schemaを検証して生成 | schemaを検証して中継・利用 | schema、codec、上限、versioningの正本 | 同じ契約を検証して利用 |
| 3D処理 | しない | しない | しない | frame alignment、履歴、人物対応、triangulation、3D solve |
| 表示 | 2D診断 | 3D avatarと演出 | scene graph、retargeting、asset lifecycle | しない |

## 安全性とプライバシー

- カメラ映像の送信は必須機能にしない。
- pairing credential、ICE credential、session IDを永続設定や配布SB3へ保存しない。
- 外部入力はschema、version、件数、数値範囲を検証してから状態へ反映する。
- WebGPU推論を必須とし、CPU、WASM、WebGLへ無言で切り替えない。
- 拡張機能は検証済みのexact versionとSHA-256で固定し、ビルド時に自動更新しない。

## 障害時の縮退

機能は依存関係の逆順に停止します。3D avatar／fusion、2D pose streaming、QR pairingの順に無効化し、
最後にカメラpreviewと手動pairingだけを残します。拡張更新に問題がある場合は、直前に検証済みの
versionとSB3へ戻します。

時刻同期や3D復元の品質が基準を満たさない場合、推測した結果を正常値として表示せずreadinessを
失敗にします。運用者が入力、接続、校正のどの段階で止まったか確認できる診断表示を目標とします。

## 現時点で対象外のもの

- カメラ映像の録画・配信サービス
- 本リポジトリ内でのframe alignment、履歴、人物対応、triangulation、3D solve
- CPU、WASM、WebGLによるMoveNet推論fallback
- camera appによる3D計算
- アプリ側でのschema、codecの独自実装
