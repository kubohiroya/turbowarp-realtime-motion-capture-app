# 3Dサービス（#34 段階1、M-10）

最大6人を追跡する3Dサービスの段階1です。3D推定の本体はまだ無く、interface v1、stubサービス、fusion app側の
転送・検証・状況表示・timeout処理を実装しています。所有境界は#11、設計は#34を正とします。

## 置き場所

`packages/pose-3d-service`（ワークスペース内のパッケージ）。別パッケージとして再利用する予定や互換の別実装を
提供する予定が当面ないため、まずアプリ内で作り、必要になった時点で切り出します。fusion appのSB3には
TurboWarp拡張`realtimemotioncapturepose3dservice`として埋め込まれ、サービスはその拡張が起動する専用Web Worker
（ビルド時にインライン化）で動きます。

| ファイル                           | 内容                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/contracts.ts`                 | interface v1（`twrmc/pose-3d-service` v1）、`twrmc/pose-frame-3d` v2、上限、エラーコード、検証、v1への変換 |
| `src/service.ts`                   | サービス側。stub実装`stub-normal`／`stub-timeout`／`stub-invalid`                                          |
| `src/worker.ts`                    | Workerの入口                                                                                               |
| `src/client.ts`                    | fusion app側。送る前の検証、重複・古いフレームの除外、timeout、応答の検証、状態                            |
| `src/extension.ts`、`src/entry.ts` | TurboWarp拡張とWorkerの起動                                                                                |

## interface v1

すべてのメッセージが`interface: twrmc/pose-3d-service`、`version: 1`、`id`、`type`、`payload`を持ちます。

| 方向          | type                                        | payload                                                                                                                                 |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| app → service | `configure`                                 | `implementation`、`referenceId`、`cameras[]`（`cameraId`＝ペアリングのpeer名、歪みを含むcamera model、`cameraFromReference`、時刻対応） |
| app → service | `frame2d`                                   | `cameraId`と、受信した`twrmc/pose-frame-2d`（変更しない）                                                                               |
| app → service | `requestPose3d`                             | `timestampUs`（v1では`null`＝最新）                                                                                                     |
| service → app | `configured`／`accepted`／`pose3d`／`error` | 設定したカメラ、受理したsequence、`twrmc/pose-frame-3d` v2または`null`、エラーコードと理由                                              |

固定値：人数6、カメラ2〜8台、1メッセージ65,536バイト、configure timeout 2,000 ms、3D request timeout 100 ms、
転送するフレームの経過時間500 ms。

`twrmc/pose-frame-3d` v2は、v1に`referenceId`、`implementation`、人物ごとの`identitySource`、関節ごとの
`sigma`、`state`（`measured`／`constrained`／`predicted`／`missing`）、`cameraIds`を加えたものです。
`measured`は2台以上のカメラを必要とし、`missing`は位置を持ちません。`latest 3D pose JSON for avatars`は
アバター用blockが読むv1へ変換し、`measured`と`constrained`以外の関節をscore 0にします。

## fusion app

フラグ`external3dServiceV1`（`packages/app-shell/src/apps/fusion.ts`の`appFlags`）が有効なときだけ、
メニューに「3D統合を開始する」「3D統合を止める」が出ます。段階1の実装はstubだけなので、stubの値が
配布版に出ないよう既定では無効です。

開始すると、次を行います。

1. 空間と時刻の校正がREADYでなければ始めない。
2. 校正で返ってきた各カメラのcamera model、配置結果、時刻対応から設定を組み立て、Workerを起動して適用する。
3. 毎フレーム、姿勢を送ってきた各カメラの最新フレームを経過時間とともに渡し、3D poseを要求する。
   - 同じsequence、500 msより古いフレーム、不正なフレーム、配置時と別のcalibrationのフレームは送らない。
   - `captureTimestampUs`は変えない。
4. 1秒ごとに、実装名、人数、RTT、3Dの経過時間、送信・古い・不正・拒否の件数、各カメラの2Dの経過時間を表示する。
   timeoutや不正な応答のときは3D出力を空にし（`degraded`）、理由と2Dの状況を表示し続ける。
   有効な応答が戻れば`ready`に戻る。

## local-app

local-app（#36 段階5）も同じ拡張と設定の部品を使い、同じフラグで有効にします。1ページで全カメラを推定するため、
2Dフレームの`peerId`はすべて`local`で、カメラは設定したカメラID（`cam-1`…）で区別します。stubの`cameraIds`も
設定したカメラIDです。詳しくは[local-app](local-app.md)。

## 検証の状況

- 自動：`pnpm check`。パッケージの契約テスト26件（検証、stubの3実装、client の重複・古いフレーム・
  calibration不一致・timeout・不正応答・Worker失敗、拡張のblock）。
- ブラウザ：フラグを一時的に有効にしたfusion appのプレイヤーをローカルホストで配信し、2台分の合成2Dフレーム、
  配置結果、READYを与えて、メニューから開始した。
  - パッケージ化したプレイヤー内で実際のWorkerが起動し、stub-normalの`PoseFrame3D` v2（2人、17関節、
    `implementation: stub-normal`）とv1への変換が得られた
  - 経過900 msのフレームは送られず、別calibrationのフレームは不正として数えられた
  - stub-timeout／stub-invalidへ切り替えると3D出力が空になり理由を表示、stub-normalへ戻すとreadyに復帰した
  - 「3D統合を止める」でidleになり3D出力が空になった
  - ブラウザペインが非表示のためタイマーが間引かれ、RTTは約50 msと表示された。実機での計測が必要
- 未実装：3D推定の本体（#34 段階3以降）。
