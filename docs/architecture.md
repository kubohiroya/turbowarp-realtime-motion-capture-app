# システム構成

## 目的と対象範囲

`turbowarp-realtime-motion-capture-app`は、複数視点の映像から得た2D人物姿勢を会場内ネットワークで集約し、復元した3D姿勢を
演出用アバターへ反映するTurboWarpアプリケーションです。このリポジトリは完成品のcamera appと
fusion app、そのアプリ固有スクリプト、アプリシェル、設定、演出DSL、デモasset、配布SB3を所有します。

汎用的なカメラ、QR、WebRTC、データ変換、3D表示の機能は個別のTurboWarp拡張が所有します。複数拡張に
またがる処理のうち、SB3のblock列では安全な管理が難しいものは高位拡張`turbowarp-realtime-motion-capture`が
所有します。3D統合（frame alignment、人物対応付け、triangulation、3D solve）もこの高位拡張の
`poseFusion3D`が実装しており、本リポジトリでは実装しません。

## 実行構成

初期リリースでは、2つのcamera appと1つのfusion appを有線LAN上で動かす構成を基準にします。

```text
source PC A                 integration PC
┌──────────────────────┐   ┌────────────────────────────────┐
│ camera → camera app  ├─┐ │ fusion app                     │
└──────────────────────┘ ├►│  ・2D姿勢の集約                │
source PC B              │ │  ・jitter buffer／時刻対応付け │
┌──────────────────────┐ │ │  ・triangulationと3D solve     │
│ camera → camera app  ├─┘ │  ・avatar／演出                │
└──────────────────────┘   └───────────────┬────────────────┘
                                           ▼
                                   projector / display
```

映像はcamera appの端末内に留め、ネットワークへは時刻付きの2D keypointと診断情報を送ります。
デバッグ映像が将来必要になった場合も、通常の姿勢送信とは分離した任意経路として扱います。

外部3Dサービスへ転送する構成も、`PoseFrame3D`契約を満たす限り将来の選択肢として残りますが、
v0.1.0の基準構成ではfusion appが拡張のfusion blockで3Dを復元します。

## アプリシェル

画面まわりは2つの拡張が分担します。どちらもアプリより下の層にあり、SB3 bundleの先頭2つを占めます。

| 拡張 | 担当 |
|---|---|
| `@multiview-pose/app-shell`（本リポジトリ所有、member 1） | contract feature flagの注入、読み込み表示、エラー表示、flag診断 |
| `@kubohiroya/turbowarp-title-menu`（member 2） | タイトル／about画面、アプリメニュー、DSLファイルの保管と管理 |

順序には意味があります。`turbowarp-realtime-motion-capture`は評価時にfeature flagを固定するため、それを
書き込むapp-shellが必ず先頭でなければなりません。

タイトルとメニューをtitle-menuへ寄せているのは、同じUIを二重に実装しないためです。メニューの項目は
固定ではなく、SB3が`add app menu action`で登録し`when app menu action selected`で受けます。
camera appはDSLを使いませんが、メニューとタイトルのために同じ拡張を埋め込みます。

app-shellがtitle-menuに渡さず持ち続けているのは、title-menuに相当するprimitiveが無い2つ、
読み込みoverlayと実行時メッセージoverlayです。メニューの状態行はメニューごとtitle-menuへ移ったため、
現在SB3からは設定できません。

app-shellの役割は次の2つです。

1. `turbowarp-realtime-motion-capture`が読むfeature flagを、その拡張が評価される前に書き込む。
2. `@kubohiroya/turbowarp-app-shell`のDOM primitiveを使い、日本語・英語のロケール対応で、
   読み込み表示とエラー表示をステージ上に出す。

feature flagは起動時固定です。camera appとfusion appで必要なflagが異なるため、シェルはアプリごとに
別のextension IDでビルドします。

| アプリ | 有効にするflag |
|---|---|
| camera app | `webgpuMoveNetMultiPose`、`protocolV1Codec`、`cameraCalibrationV1`、`frameSyncPatternV1`、`glowStickMarkers` |
| fusion app | `qrCourierPairing`、`protocolV1Codec`、`avatarRetargetV1`、`frameSyncPatternV1`、`poseFusion3D`、`glowStickMarkers` |

シェルは`feature flag state`reporterで適用結果を公開します。`applied`以外の値は、bundleの並び順が
壊れていて契約拡張が先に評価されたことを意味するため、起動を続けずreadinessを失敗にします。

アプリメニューの操作はtitle-menuの`when app menu action [ACTION] selected`hatへ届きます。どちらの
拡張も運用手順を持たず、何をするかはSB3側のスクリプトが決めます。

## 起動から停止までの流れ

以下はv0.1.0で本アプリが実現する予定の運用フローです。SB3のblockスクリプトは未実装です。

1. fusion appがセッションを作成し、接続用QRコードを表示する。
2. 各camera appがカメラを選択し、映像と実際の解像度・FPSを確認する。
3. camera appがQRコードを読み取り、fusion appとのDataChannelを確立する。
4. fusion appがsession policyとcalibration参照を配布する。
5. WebRTC拡張のclock syncで、camera appとfusion appの時計を合わせる。
6. fusion appがフレーム同期パターンを表示し、各camera appがカメラ遅延を測って報告する。
7. 各camera appがWebGPU版MoveNet MultiPoseで2D姿勢を推定する。
8. camera appが最新の`PoseFrame2D`をlatest-data channelで送り、遅れた古いframeは蓄積しない。
9. fusion appが`PoseFrame2D`をjitter bufferへ入れ、過去の一点で全カメラを再sampleして統合する。
10. fusion appが`PoseFrame3D`をavatar retargetへ渡し、performance DSLに従って表示を更新する。
11. 終了時は推論、通信、カメラの順に停止し、一時的な接続情報を破棄する。

## アプリと拡張の責務

| 領域 | camera app | fusion app | TurboWarp拡張 |
|---|---|---|---|
| 画面と操作フロー | カメラ選択、preview、状態表示 | セッション、校正、演出、readiness表示 | タイトル、メニュー、DSL管理、overlay、再利用可能なblock |
| カメラ映像 | 端末内で取得・推論 | 受信しない | camera lifecycleとGPU入力 |
| 通信 | 2D姿勢と診断を送信 | policy送信、2D姿勢の集約 | QR courier、WebRTC channel、backpressure、clock sync |
| データ契約 | schemaを検証して生成 | schemaを検証して利用 | schema、codec、上限、versioningの正本 |
| 3D処理 | しない | fusion blockを呼ぶ | jitter buffer、人物対応付け、triangulation、3D solve |
| 表示 | 2D診断 | 3D avatarと演出 | scene graph、retargeting、asset lifecycle |

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

アプリシェルの表示が失敗しても、演出そのものは止めません。シェルは`app shell state`を
`unavailable`にして、block呼び出しを黙って無視します。

## 現時点で対象外のもの

- カメラ映像の録画・配信サービス
- CPU、WASM、WebGLによるMoveNet推論fallback
- camera appによる3D計算
- アプリ側でのschema、codecの独自実装
- 本リポジトリでのfusionアルゴリズム実装（拡張が所有する）
