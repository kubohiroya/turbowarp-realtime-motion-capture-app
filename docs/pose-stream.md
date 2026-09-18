# 姿勢推定と送信（M-09）

camera appがWebGPUのMoveNet MultiPoseで2D姿勢を推定し、`twrmc/pose-frame-2d`をfusion appへ送ります。
推論、tracking、フレーム文書の生成は`turbowarp-realtime-motion-capture`が担当し、このリポジトリのscript
（`scripts/app-scripts/pose.ts`）は、開始条件の判定、推論の繰り返し、送信、状況表示を担当します。

## 操作

camera appのメニュー「姿勢推定を開始する」「姿勢推定を止める」。次の条件をすべて満たすときだけ開始し、
満たさなければ理由を表示して推論を始めません。

- 起動時フラグ`webgpuMoveNetMultiPose`が有効。#9が挙げた`movenetMultiPoseWebGpu`（推論）と
  `poseDataChannel`（送信）は、このフラグ1つにまとめている。推論して送らない運用は無いため
- カメラが動いている
- 今のカメラに合うレンズ校正が適用されている（`calibrationId`にそのprofile IDを入れるため）
- 統合アプリとQRペアリングで接続し、その接続が`connected`

開始後は推論を繰り返し、1秒ごとに人数、FPS、推論1回（VMのフレーム待ちを含む）、送信件数、破棄件数、
送信量、最新の`sequence`を表示します。統合アプリとの接続が切れたら、推論を止めてエラーを表示します。
カメラを止めたとき、カメラが切断されたときも止まります。

## モデルの読込み元

MoveNet MultiPose Lightningのモデル（`model.json`とweight 3つ、9.7 MB）をどこから読むかは、ビルド時に
`TWRMC_POSE_MODEL`で選びます。アプリはそれを`turbowarp-realtime-motion-capture` 0.6.0の
`__TWMP_POSE_MODEL__`に変えて渡します（`packages/app-shell/src/pose-model.ts`）。

| `TWRMC_POSE_MODEL` | 読込み元                                               | 会場のinternet | SB3の大きさ   |
| ------------------ | ------------------------------------------------------ | -------------- | ------------- |
| 未設定（`hub`）    | TF Hub。配布物の既定                                   | 要る           | 変わらない    |
| `local`            | 会場のホスト（`serve:app`、単体バイナリ）の`/models/…` | 要らない       | 変わらない    |
| `embedded`         | app shellに同梱し、memoryから渡す                      | 要らない       | 約12 MB増える |

- モデルはGitに入れません。`config/pose-model.json`がファイルごとの大きさとSHA-256を固定し、
  `pnpm run fetch:pose-model`がTF Hubから`models/movenet-multipose-lightning/`へ取得して照合します
  （`-- --check`でnetworkを使わずに照合だけ）。`local`と`embedded`のビルドは、固定したものと違えば止まります。
- `pnpm run build:offline`は、モデルの取得、パッケージのビルド、埋め込み拡張のpin、SB3とプレイヤーの
  ビルドを、既定では`local`で行います（`TWRMC_POSE_MODEL=embedded pnpm run build:offline`で同梱）。
  計測ビルドと同じくpinを書き換えるので、コミットせず、`pnpm run build:workspaces && pnpm run
pin:extensions`で戻します。
- `local`のビルドは、app shellのビルドが`packages/app-shell/dist/<app>/pose-model.json`に選んだ読込み元を
  残します。`serve:app`と`build:binary`はそれを見て、モデルのファイルをホストから配信します
  （単体バイナリにはファイルとして同梱）。ホストはtokenの付いた要求にだけ答えるので、app shellは
  ページのtokenをモデルのURLに付けます。TensorFlow.jsはweightにも同じqueryを付けて取りに行きます。
- 対象はcamera appとlocal app（推論する2つ）です。fusion appは推論しないので変わりません。

## 送るもの

`startWebGpuMoveNetMultiPose`に次を渡し、拡張がフレームに入れます。

| フィールド                                                                                           | 値                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `cameraId`                                                                                           | `pose`                                                                                                        |
| `peerId`                                                                                             | 統合アプリから見たこのカメラの名前（ペアリングのlocal peer、`camera-1`など）                                  |
| `calibrationId`                                                                                      | Camera Sourceに登録されたレンズ校正profileの`profileId`                                                       |
| `captureTimestampUs`                                                                                 | 推論直前の`turbowarp-webrtc`の`local time`（整数µs）。#11の方針どおり、WebRTCの時刻サービスの値を変えずに使う |
| `sequence`、`frameWidth`、`frameHeight`、`persons`（最大6人、17 keypoint、confidence、`trackingId`） | 拡張が生成                                                                                                    |

`captureTimestampUs`はフレームの撮影時刻ではなく、推論を依頼した時刻です。撮影時刻との差はM-08の時刻対応
（`displayToTimestampDelayUs`）とは別に残ります。

## 送信経路

- `pose`という名前のlatest-data channelで送ります。fusion appはペアリングのOfferを作る前にこのchannelを
  用意し（high-water mark 16 KB、約2フレーム分）、両アプリは起動時にlatest-dataを有効にします。
- 送信待ちがhigh-water markを超えていれば、新しいフレームは送らずに捨て、破棄件数に数えます。古いフレームを
  溜めて遅延を積み上げることはしません。
- latest-dataの受信はテストメッセージや校正メッセージと同じ受信キューに入ります。app shellの
  `sort network messages`が毎フレームそのキューをすべて取り出し、姿勢フレームはカメラごとに最新の1件だけ
  残し、その他のメッセージは順番どおり受信用scriptへ渡します。これにより姿勢フレームが制御メッセージを
  遅らせません。

WebRTC拡張は受信キューをruntime capabilityに公開していないため、app shellは拡張のblock実装
（`kubohiroyawebrtc_messageCount`／`nextMessage`、bundle内では`<bundle>_kubohiroyawebrtc__...`）を
VMの`_primitives`から探して呼びます。WebRTC拡張のcapabilityに受信キューが加われば置き換えられます。

fusion appの「動作状況を見る」は、カメラごとの受信件数、最新フレームの経過時間、`sequence`、人数、
`calibrationId`を表示します。フレームの利用はM-10です。

## 検証の状況

- 自動：`pnpm check`（app shellの受信整理のテストを含む）。
- ブラウザ（実物）：MoveNetがWebGPU backendを初期化し、モデルを読み込むところまで進むことを確認した
  （約5秒、モデルはネットワークから取得）。その後はブラウザペインがカメラを許可しないため
  `camera-unavailable`で止まる。
- ブラウザ（推論のみ合成）：ローカルホストで両アプリを配信してペアリングし、推論のblockを合成フレームを返す
  ものに置き換えて、メニューから次を確認した。
  - 未接続では`POSE_NOT_CONNECTED`で推論を始めない
  - 開始時にprofile ID、`pose`、`camera-1`が渡り、30 FPSで送信され、破棄0件
  - fusion appが全フレームを受け取り、ヘッダ、17 keypoint、手を上げる動きが届く
  - 受信整理後もペアリングのテストメッセージが届く
  - fusion app側で接続を閉じると、camera appが`POSE_DISCONNECTED`で止まり、以後推論しない
- モデルのオフライン配布（`TWRMC_POSE_MODEL`）：
  - 拡張0.6.0のMoveNetの読込みを検証ページで実際に動かし、`{ url }`ではローカルの`model.json`とweightだけ、
    `{ modelJson, weights }`ではnetworkアクセス無しで読み込み、WebGPUで推論まで通ることを確認した。
  - `build:offline`の`local`で作ったcamera appを`serve:app`で開き、ページがtoken付きのモデルURLを
    `__TWMP_POSE_MODEL__`に置くこと、ホストがtoken付きの要求にだけ`model.json`とweightを返すこと
    （無ければ401）を確認した。`embedded`では、ページがモデル本体とweight 3つを持ち、ホストは配信しない
    ことを確認した。
  - 拡張0.6.0を埋め込んだ`local`のcamera appで、ページから姿勢推定のpipelineを開始し、WebGPUを初期化した
    うえで、モデルを会場のホストの`model.json`とweight 3つだけから読み込み（TF Hubへの要求は無し）、
    カメラの取得まで進むことを確認した（ブラウザペインはカメラを許可しないため、そこで
    `camera-unavailable`で止まる）。
  - 単体バイナリへの同梱（`build:binary`）は、この環境にBunが無いため未確認。
- 未確認：実カメラでの推論と精度、実際のFPSと推論時間、別PC間の帯域とbackpressure。
