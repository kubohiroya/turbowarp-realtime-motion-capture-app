# アプリ間protocol

この文書はcamera appとfusion appが利用するデータ契約と、安全に扱うためのアプリ側の方針を示します。
具体的なfield定義や上限値の正本ではありません。

データ契約（schema）は高位拡張`kubohiroya/turbowarp-multiview-pose`が所有します。本リポジトリは
その契約の利用者であり、定義を複製しません。依存方向はapplicationからextensionへの一方向です。

## 利用する契約

| 契約 | schema識別子 | 用途 |
|---|---|---|
| Session policy | `twmp/session-policy` | revision、有効期限、session topology、calibration参照、MoveNet設定、運用上限。pairing credentialは含めない |
| Camera calibration | `twmp/camera-calibration` | 画像geometry、intrinsic、distortion、camera-to-world transform |
| PoseFrame2D v1 | `twmp/pose-frame-2d` | 最大6人分のtracking IDと順序固定COCO-17画像keypoint |
| PoseFrame2D v2 | `twmp/pose-frame-2d` | v1に加えて、人物ごとのサイリウムmarker観測（最大4件） |
| PoseFrame3D | `twmp/pose-frame-3d` | 最大6人分の3D姿勢と品質情報 |
| Performance DSL | `twmp/performance-dsl` | 最大6人分の色、開始／終了演出、avatar asset |

正本の定義は`turbowarp-multiview-pose`の`src/protocol/schemas.ts`にあり、生成したJSON Schemaは
同repositoryの`schemas/`で配布します。app側はextensionのcodec blockを通してvalidateとencodeを
行い、JSON Schemaを再実装しません。extensionのexact versionとartifact SHA-256は
[`config/extension-readiness.json`](../config/extension-readiness.json)で固定します。

## 互換性と検証

すべてのpayloadは、安定した`schema`識別子とliteralの`version`を持つ。同じ`schema`識別子の各
versionは独立した契約であり、上位versionのpayloadを下位version parserが受理することはない。
未知version、未知field、必須fieldの欠落、安全範囲外の数値、上限を超えるcollectionは、
application stateを変更する前に拒否します。parserはfail-closedとします。

validation失敗時は、直前に検証済みの状態を維持し、受信元、schema、version、拒否理由を診断へ
記録します。部分的に解釈したpayloadでアプリ状態を更新してはいけません。

## 一時データと永続データ

pairing offer／answer、ICE credential、QR courier partは一時的なprotocol dataである。session
policyまたはperformance DSLのfieldではなく、永続的なapp設定や配布SB3へ書き込んではいけません。

calibrationとperformance DSLは永続化できますが、適用前にschema versionと参照先を検証します。
保存先と復元手順は[永続化設計](persistence.md)、会場固有のファイルをリポジトリへcommitしない方針は
[SB3開発ガイド](repository-layout.md)を参照してください。

## timestampと3D処理

`captureTimestampUs`と`timestampUs`は、WebRTC拡張のclock sync blockが提供する同期済みlocal time
serviceの値をそのまま運びます。application scriptは値を作り直したり、受信時刻で置き換えたりしません。
clock offsetの推定、probe、ping／pongはWebRTC拡張が所有し、`turbowarp-multiview-pose`も本アプリも
実装しません。

複数camera由来のtimestamp付きPoseFrame2Dの時刻対応付け、履歴保持、triangulationによる
PoseFrame3D復元は、高位拡張`turbowarp-multiview-pose`の`poseFusion3D`が実装します。fusion appは
受信したPoseFrame2Dをfusion blockのbufferへ入れ、統合結果を表示consumerへ渡すだけで、frame
alignment、history query、triangulation、3D solveを自前で実装しません。

アプリ全体でのデータフローは[システム構成](architecture.md)を参照してください。
