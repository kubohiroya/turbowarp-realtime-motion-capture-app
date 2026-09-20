# TurboWarp拡張 readiness

この文書は[`config/extension-readiness.json`](../config/extension-readiness.json)の人間向け要約です。
そのJSONは[`config/extension-requirements.json`](../config/extension-requirements.json)と、各アプリが
実際に埋め込んでいるversionから`pnpm run update:readiness`で生成します。手で編集しないでください。

利用者向けの実装状況は[README](../README.md)、アプリと拡張の責務分担は
[システム構成](architecture.md)を参照してください。

## リポジトリ境界

```text
generic extensions
  camera-source / jsqr / webrtc / yaml-json / asset-manager / aframe /
  diagnostic-overlay / app-shell / title-menu
                         |
                         v
turbowarp-realtime-motion-capture
  安定したmultiview固有blockとcomposite block、protocol契約、3D fusion
                         |
                         v
turbowarp-realtime-motion-capture-app
  app shell拡張、SB3 script、extension pin、camera app.sb3 / fusion app.sb3
```

application repositoryはSB3 script、アプリシェル、performance DSL、calibration profile、demo asset、
extension pin、配布artifactを所有する。`turbowarp-realtime-motion-capture`は再利用可能なmultiview固有処理を
所有するが、完成品applicationは所有しない。

## 現在のreadiness（2026-09-18確認）

| 役割                  | package/version                                       | 状態  | 備考                                                                                                                                                             |
| --------------------- | ----------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App UI                | `@kubohiroya/turbowarp-title-menu@0.2.2`              | Ready | タイトル、アプリメニュー、DSLファイル管理。メニュー項目はblockから定義する                                                                                       |
| Camera source         | `@kubohiroya/turbowarp-camera-source@0.13.0`          | Ready | preview block、実width/height/FPS reporter、device列挙まで揃った                                                                                                 |
| QR reader             | `@kubohiroya/turbowarp-jsqr@0.4.0`                    | Ready | zxing-cpp。ペアリング拡張がruntime capabilityの`readFrame`で連結QRコードの位置まで読むので、runtime variable経由の受け渡し（Temporary Variables依存、#19）は無い |
| WebRTC                | `@kubohiroya/turbowarp-webrtc@0.4.0`                  | Ready | runtime capability v3（Offerの受理とAnswer）、latest-data pose channel、clock sync、frame latency report                                                         |
| QR pairing            | `@kubohiroya/turbowarp-webrtc-qrcode-pairing@0.2.3`   | Ready | Offer／Answerを連結QRコードで運ぶ。交換が終わるとQRのデータを捨てる。WebRTC capability v3が必要                                                                  |
| Time-space sync       | `@kubohiroya/turbowarp-time-space-sync@0.2.0`         | Ready | 投影に対するカメラのrollは±45°以内、鏡像は不可                                                                                                                   |
| DSL values/schema     | `@kubohiroya/turbowarp-yaml-json@0.3.0`               | Ready | 外部DSL textのsafe parseとJSON Schema検証が揃った                                                                                                                |
| Assets/animation      | `@kubohiroya/turbowarp-asset-cache@0.1.0`             | Ready | block API manifestを配布済み。app asset manifestは未確定                                                                                                         |
| 3D scene              | `@kubohiroya/turbowarp-aframe@0.5.0`                  | Ready | scene capability v2（VRMのボーンと表情）。A-Frame 1.8.0をjsDelivrからSRI付きで読込                                                                               |
| Diagnostics           | `@kubohiroya/turbowarp-diagnostic-overlay@0.4.0`      | Ready | block API manifestを配布済み。app readiness payloadは未確定                                                                                                      |
| Motion capture blocks | `@kubohiroya/turbowarp-realtime-motion-capture@0.5.0` | Ready | 103 block。personにbindしたVRMのボーンと表情を動かす                                                                                                             |

すべての固定artifactは`node scripts/check-extension-readiness.ts --verify-network`で公開bundleと
manifestに照合済みです。release build自体はnetwork accessなしで、commit済みartifactだけを使用します。

## 未解決の項目

### `extensions status`が使えない拡張

`@kubohiroya/turbowarp-realtime-motion-capture`の配布bundleはOpenCV.js WebAssemblyを内包するため13.7 MBあり、
`sb3-toolchain extensions status`の5 MB上限を超えます。integrityは`sb3-toolchain check`とビルドで
検証されるので配布物の安全性には影響しませんが、更新確認は`scripts/pin-embedded-extensions.ts`で
行います。

### メニュー状態行

`turbowarp-title-menu`にはメニューの状態行を設定するblockが無い。状態行はメニューごとtitle-menuへ
移ったため、現在SB3からは設定できない。必要になった時点でtitle-menu側へblockを追加する。

### app asset manifestとreadiness payload

Asset ManagerとDiagnostic Overlayはblock APIが確定しましたが、このアプリがどのassetを固定し、
どのreadiness payloadを表示するかは未定です。SB3スクリプトの実装と同時に決めます。

## gate判定

### Camera shell

Camera Source 0.5.0でcamera acquisitionとGPU previewをblockから実行できる。applicationが別の
`getUserMedia()`を呼ぶことを禁止する。

### QR courier pairing

jsQRとreliable WebRTC pairing経路は利用可能である。QR envelope生成、複数part再構成、Version 40
render、一時sprite skin lifecycle、cleanupは`turbowarp-realtime-motion-capture`が実装済みである。manual
copy/paste pairingをrollback経路として維持する。

### Pose streaming

MoveNet MultiPoseはTensorFlow.js WebGPU backendで実行し、選択backendが`webgpu`でない場合は起動を
拒否する。CPU、WASM、WebGL inference fallbackは対象外である。pose frameはWebRTC 0.3.0の
latest-data channelで送り、`bufferedAmount`とdrop countをreadinessに出す。

### Clock sync

WebRTC 0.3.0の`syncClock`／`clockOffset`／`clockUncertainty`を時刻の正本とする。アプリも
`turbowarp-realtime-motion-capture`もclock推定を実装しない。frame latencyは同拡張のframe sync report blockへ
集約する。

### 集約、3D fusion、avatar demo

`PoseFrame2D`、`PoseFrame3D`、calibration、session policy、performance DSL v1は0.1.0で固定済みである。
fusion appはtimestamp付きPoseFrame2Dを`bufferPoseFrame2D`へ入れ、`fuseBufferedPoseFrame3D`の結果を
`applyPoseFrame3DToAvatars`へ渡す。このgateは0.2.0のreleaseを待つ。

## composite blockへ昇格する基準

単一extensionの安定したblockで表現できる操作は、そのgeneric extensionに置く。複数extensionの
runtime API、resource ownership、非同期state、cleanupを一体で扱う必要があり、SB3 block列では保守が
困難な操作だけを`turbowarp-realtime-motion-capture`の高位blockへ昇格する。

再利用できる画面（タイトル、アプリメニュー、DSLファイル管理）は`turbowarp-title-menu`が所有する。
このリポジトリが所有する`@turbowarp-realtime-motion-capture-app/app-shell`拡張に残すのは、起動時のfeature flag注入と、
title-menuに相当するprimitiveが無い読み込み・エラーoverlayだけとする。

## artifact policy

applicationへ埋め込む前に、exact npm version、extension ID、artifact URL、SHA-256、block contractを
inventoryへ記録する。記録は[`config/app-extensions.json`](../config/app-extensions.json)の宣言から
`pnpm run pin:extensions`で生成し、`pnpm run update:readiness`でinventoryへ反映する。

## rollback

直前のextension pinを保持し、問題がある機能を依存関係の逆順、すなわちavatar/fusion、pose stream、
QR courier、previewの順で無効化する。機能の無効化はapp shellのfeature flag宣言を変更して再ビルド
することで行う。camera lifecycleとmanual WebRTC pairingは独立してtest可能な状態を維持する。
