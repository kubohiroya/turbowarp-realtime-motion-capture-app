# multiview-pose application contracts

camera appとfusion appが交換または保存するdataの契約（schema）は、高位extension
`kubohiroya/turbowarp-multiview-pose`が所有する。本repositoryはその契約の利用者であり、定義を
複製しない。依存方向はapplication → extensionの一方向に限る。

| 契約 | schema識別子 | 用途 |
|---|---|---|
| Session policy | `twmp/session-policy` | revision、有効期限、session topology、calibration参照、MoveNet設定、運用上限。pairing credentialは含めない |
| Camera calibration | `twmp/camera-calibration` | 画像geometry、intrinsic、distortion、camera-to-world transform |
| PoseFrame2D v1 | `twmp/pose-frame-2d` | 最大6人分のtracking IDと順序固定COCO-17画像keypoint |
| PoseFrame2D v2 | `twmp/pose-frame-2d` | v1に加えて、人物ごとのサイリウムmarker観測（最大4件） |
| PoseFrame3D | `twmp/pose-frame-3d` | 最大6人分の3D姿勢と品質情報 |
| Performance DSL | `twmp/performance-dsl` | 最大6人分の色、開始／終了演出、avatar asset |

正本の定義は`turbowarp-multiview-pose`の`src/protocol/schemas.ts`にあり、生成したJSON Schemaは
同repositoryの`schemas/`で配布する。app側は、extensionのcodec blockを通してvalidateとencodeを
行い、JSON Schemaを再実装しない。extensionのexact versionとartifact SHA-256は
`config/extension-readiness.json`で固定する。

すべてのpayloadは、安定した`schema`識別子とliteralの`version`を持つ。同じ`schema`識別子の各
versionは独立した契約であり、上位versionのpayloadを下位version parserが受理することはない。
未知version、未知field、必須fieldの欠落、安全範囲外の数値、上限を超えるcollectionは、
application stateを変更する前に拒否する。parserはfail-closedとする。

pairing offer／answer、ICE credential、QR courier partは一時的なprotocol dataである。session
policyまたはperformance DSLのfieldではなく、永続的なapp設定へ書き込んではならない。

`captureTimestampUs`と`timestampUs`は、別途提供される同期済みlocal time serviceが生成した値を
そのまま運ぶ。本projectはtime serviceの初期化、offset推定、ping／pong、再調整、timestamp生成を
実装しない。

複数camera由来のtimestamp付きPoseFrame2Dの時刻対応付け、履歴保持、triangulationによる
PoseFrame3D復元はextension側が実装する。本projectはそれらのblockを組み合わせるだけで、
frame alignment、history query、triangulation、3D solveを自前で実装しない。
