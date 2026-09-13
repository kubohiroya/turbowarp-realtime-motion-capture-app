# TurboWarp拡張 readiness

この文書は[`config/extension-readiness.json`](../config/extension-readiness.json)の人間向け要約です。
利用者向けの実装状況は[README](../README.md)、アプリと拡張の責務分担は
[システム構成](architecture.md)を参照してください。

[epic #1](https://github.com/kubohiroya/multiview-pose/issues/1)の最初の開発gateとして、必要な操作が
テスト可能なTurboWarp blockになるまでapplication scriptへ組み込みません。表の`Partial`は、公開済み
拡張に利用可能な機能はあるものの、このアプリが必要とするblockが揃っていない状態を意味します。

## リポジトリ境界

```text
generic extensions
  camera-source / jsqr / webrtc / yaml-json / asset-manager / aframe
                         |
                         v
turbowarp-multiview-pose
  安定したmultiview固有blockとcomposite block
                         |
                         v
multiview-pose
  sb3-toolchainでbuildするcamera app.sb3 / fusion app.sb3
```

application repositoryはSB3 script、performance DSL、calibration profile、demo asset、extension pin、
配布artifactを所有する。`turbowarp-multiview-pose`は再利用可能なmultiview固有処理を所有するが、
完成品applicationは所有しない。

## 現在のreadiness（2026-09-13確認）

| 役割 | package/version | 状態 | 利用可能 | 次に必要な作業 |
|---|---|---|---|---|
| Camera source | `@kubohiroya/turbowarp-camera-source@0.4.0` | Partial | named camera lifecycleとGPU-backed preview runtime API | [preview blockと実width/height/FPS reporter](https://github.com/kubohiroya/turbowarp-camera-source/issues/8) |
| QR reader | `@kubohiroya/turbowarp-jsqr@0.3.0` | Ready with dependency | 待機、decode、runtime variable格納、broadcast | Temporary Variables依存を維持するか決定 |
| WebRTC | `@kubohiroya/turbowarp-webrtc@0.2.0` | Partial | LAN offer/answer、state、reliable JSON message | [latest-data pose channel、`bufferedAmount`、drop policy、stable capability API](https://github.com/kubohiroya/turbowarp-webrtc/issues/10) |
| DSL values/schema | `@kubohiroya/turbowarp-yaml-json@0.2.0` | Partial | immutable value、JSON/YAML render、JSON Schema validation | [外部から読んだDSL textのsafe parse](https://github.com/kubohiroya/turbowarp-yaml-json/issues/3) |
| Assets/animation | `@kubohiroya/turbowarp-asset-manager@0.15.0` | Partial | pinned asset、sprite skin、sound、actor sequence | [block API manifestの配布](https://github.com/kubohiroya/turbowarp-asset-manager/issues/116)後にapp asset manifestを確定 |
| 3D scene | `@kubohiroya/turbowarp-aframe@0.2.0` | Partial | scene graphとanimation block | [PoseFrame3D-to-avatar高位retargeting block](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/4) |
| Diagnostics | `@kubohiroya/turbowarp-diagnostic-overlay@0.3.0` | Partial | structured stage overlay | [block API manifestの配布](https://github.com/kubohiroya/turbowarp-diagnostic-overlay/issues/13)後にapp readiness payloadを確定 |
| Multiview blocks | 未release | Missing | repositoryと実装sub-issueは作成済み | [QR表示](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/2)、[pose codec](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/3)、[avatar retarget](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/4)、[MoveNet WebGPU](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/5)、[calibration](https://github.com/kubohiroya/turbowarp-multiview-pose/issues/6) |

## gate判定

### Camera shell

Camera Source 0.4.0でcamera acquisitionを開始できる。applicationが別の`getUserMedia()`を呼ぶことを
禁止する。camera shell完了には、GPU previewを`acquireCamera({preview: true})`だけでなくblockから
実行可能にする必要がある。

### QR courier pairing

jsQRとreliable WebRTC pairing経路は利用可能である。QR envelope生成、複数part再構成、Version 40
render、一時sprite skin lifecycle、cleanupは`turbowarp-multiview-pose`で実装する。manual
copy/paste pairingをrollback経路として維持する。

### Pose streaming

MoveNet MultiPoseはTensorFlow.js WebGPU backendで実行し、選択backendが`webgpu`でない場合は起動を
拒否する。CPU、WASM、WebGL inference fallbackは対象外である。現行WebRTC event blockはcontrol
messageに使えるが、applicationからbackpressureを制御できないため、置換可能なpose frame channelの
最終実装には使用しない。

### 集約、外部3D service連携、avatar demo

child Issue #5で`PoseFrame2D`、`PoseFrame3D`、calibration、session policy、performance DSL v1を
固定してから、retargetingを実装する。fusion appはtimestamp付きPoseFrame2Dを集約・転送し、外部
serviceが返したPoseFrame3Dをconsumerへ渡す。frame alignment、履歴、任意過去時点query、
triangulation、3D solveは実装しない。

## composite blockへ昇格する基準

単一extensionの安定したblockで表現できる操作は、そのgeneric extensionに置く。複数extensionの
runtime API、resource ownership、非同期state、cleanupを一体で扱う必要があり、SB3 block列では保守が
困難な操作だけを`turbowarp-multiview-pose`の高位blockへ昇格する。

## artifact policy

applicationへ埋め込む前に、exact npm version、extension ID、artifact URL、SHA-256、block contractを
inventoryへ記録する。`node scripts/check-extension-readiness.mjs --verify-network`で公開bundleとmanifestを
照合する。release build自体はnetwork accessなしで、commit済みartifactだけを使用する。

## rollback

直前のextension pinを保持し、問題がある機能を依存関係の逆順、すなわちavatar/fusion、pose stream、
QR courier、previewの順で無効化する。camera lifecycleとmanual WebRTC pairingは独立してtest可能な
状態を維持する。
