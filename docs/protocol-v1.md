# multiview-pose protocol v1

protocol packageを、camera appとfusion appが交換または保存するデータのSingle Source of
Truthとする。TypeScript型は、`packages/protocol/schemas/`以下のJSON Schemaを生成するものと
同じTypeBox定義から導出する。

すべてのpayloadは、安定した`schema`識別子とliteralの`version: 1`を持つ。未知version、未知field、
必須fieldの欠落、安全範囲外の数値、上限を超えるcollectionは、application stateを変更する前に拒否する。

| 契約 | schema識別子 | 用途 |
|---|---|---|
| Session policy | `twmp/session-policy` | session topologyと運用上限。pairing credentialは含めない |
| Camera calibration | `twmp/camera-calibration` | 画像geometry、intrinsic、distortion、camera-to-world transform |
| PoseFrame2D | `twmp/pose-frame-2d` | 最大6人分のtracking IDと順序固定COCO-17画像keypoint |
| PoseFrame3D | `twmp/pose-frame-3d` | 最大6人分の3D姿勢、使用camera、reprojection品質 |
| Clock probe | `twmp/clock-probe` | clock offsetとRTT推定用のversion付きping／pong timestamp |
| Performance DSL | `twmp/performance-dsl` | 最大6人分の色、開始／終了演出、avatar asset |

pairing offer／answer、ICE credential、QR courier partは一時的なprotocol dataである。session
policyまたはperformance DSLのfieldではなく、永続的なapp設定へ書き込んではならない。

v1 parserはfail-closedとする。将来versionは、そのschemaとapplicationの明示対応を追加するまで拒否する。
validation失敗時はsession開始と3D出力を止める。commit済みv1 parserと最後にvalidだったcalibrationを
rollback先とする。
