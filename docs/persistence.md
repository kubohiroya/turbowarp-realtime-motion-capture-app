# 永続化設計（設計中）

> [!NOTE]
> 方針は確定していますが、実装はまだありません。残っている論点は「未決定」として明示しています。

現在、演出DSLも校正結果もメモリ上にしか存在せず、projectを閉じると失われます。会場で毎回カメラを
校正し直すのは現実的ではないため、次の2つを永続化する必要があります。

1. fusion appが読み込む**performance DSL**
2. camera appが作る**カメラ設定一式**（レンズ校正、カメラ選択、同期の測定結果）

## 決定事項

- DSLは会場でファイルから読み込む。**SB3へは埋め込まない。**
- カメラ設定のキャッシュキーは**`cameraId` + `calibrationId`**とする。IPアドレスは使わない。
- 保存先はブラウザのIndexedDB。これはキャッシュであり、正の保存経路はファイルへのexport／import。
- 復元はfail-closed。検証を通り、運用者が確認したものだけを適用する。

残る論点は「[どの拡張が持つか](#未決定-どの拡張が持つか)」だけです。

## performance DSLの読み込み

`tm-kamishibai`と同じ方式を踏襲します。すなわち、ファイル／ディレクトリを運用者が選び、読み込んだ
内容のSHA-256を記録し、参照を解決してから適用します。

- 読み込んだテキストは`@kubohiroya/turbowarp-yaml-json`の`parse text`でsafe parseし、
  `twrmc/performance-dsl` v1として`validate schema`で検証してから適用する。
- 読み込んだDSLはブラウザにキャッシュし、次回起動時に選び直さなくてよいようにする。
  キャッシュのキーは読み込んだ内容のSHA-256とし、同じ内容を二重に持たない。
- **DSLをSB3へ埋め込むことはしない。** 配布SB3にはDSLが1つも入らないため、fusion appは起動時に
  必ず読み込み経路を通る。会場固有の演者名や色が配布artifactへ混入する余地をなくすことを優先し、
  デモ用のサンプルDSLもSB3ではなくリポジトリのファイルとして配る。

DSLが1つもキャッシュされていない初回起動では、運用者に読み込みを促す必要があります。UIには
`@kubohiroya/turbowarp-app-shell`の`createAppShellSourceChooser`が使えます。app shell拡張へ
source chooserを追加するのは未実装です。

## カメラ設定のfusion側集約

camera appが校正・選択・同期を終えたら、その結果をfusion appへ送り、fusion appがブラウザに保存
します。次回そのcamera appが接続してきたら、fusion appが保存済みの設定を返し、camera app側の
やり直しを省きます。

この方向自体は妥当です。fusion appはすでにsession policyを配布する立場にあり、設定の正本を
fusion側に置くのは責務分担と一致します。camera app側にも同じ内容のローカル控えを持たせ、fusion app
が使えないときでも単独でカメラを立ち上げられるようにします。

### キャッシュのキー

キーは**`cameraId`と`calibrationId`の組**とします。どちらも`twrmc/camera-calibration` v1が持つ
fieldで、`cameraId`は運用者が付ける安定した名前（例: `stage-left`）、`calibrationId`はその校正
実施を識別します。fusion appは`cameraId`で候補を引き、`calibrationId`で世代を区別します。

同じ`cameraId`に複数の校正がある場合は、最も新しいものを既定候補として提示し、過去の世代も
選べるようにします。`cameraId`が未知なら、キャッシュは無いものとして扱い、通常の校正手順へ
進みます。推測でよく似た候補を当てにいくことはしません。

camera appのIPアドレスをキーにする案は、次の3点から採用しません。

1. 会場LANは通常DHCPで、IPは日をまたぐと変わり、使い回されます。キャッシュのmissだけならまだしも、
   **別のPCが前のPCのIPを受け取って誤ヒットする**ことがあります。そうなるとカメラBに
   カメラAのintrinsicが入り、三角測量は「もっともらしく間違った」結果を出します。これは
   「推測した結果を正常値として表示しない」という原則に真正面から反します。
2. WebRTCではfusion appがpeerのIPを確実に知ることはできません。ブラウザはhost candidateをmDNSの
   `.local`名に難読化するため、IPが取れない環境があります。
3. IPアドレスは会場ネットワーク構成の記録でもあり、端末・会場固有のデータを残さない方針と
   相性がよくありません。

IPアドレスは候補を並べ替えるヒントとしてなら使えますが、同一性の根拠にはしません。

### データごとの再利用可否

「設定データ一式」をまとめて復元するのではなく、性質ごとに分けます。

| データ | 再利用 | 理由 |
|---|---|---|
| レンズintrinsic／distortion | 再利用する | カメラとレンズに固有で、動かしても変わらない |
| `worldFromCameraMatrix`（外部パラメータ） | 参考値として提示する | カメラを動かした瞬間に無効。復元時は「動かしていない」ことの確認か再校正を要求する |
| カメラ選択（`deviceId`） | ヒントとしてのみ使う | `deviceId`はブラウザとプロファイルに固有で変わる。deviceラベルと解像度で照合する |
| フレーム遅延・時刻offset | 毎回測り直す | 露出、プロジェクタ、負荷で変わる。復元すると静かにタイミングが狂う |

### 復元時の検証

復元はfail-closedにします。適用前に次を確認し、1つでも合わなければ適用せずreadinessを失敗にします。

- `twrmc/camera-calibration` v1として検証できること
- `cameraId`が今つないでいるcameraと一致すること
- 実際のカメラ解像度が校正時の解像度と一致すること
- pairing credentialを含むkeyが混入していないこと（拡張のimportがすでに再帰的に拒否する）

取得日時を運用者に見せ、確認してから適用します。無言のauto-applyにはしません。

## 保存先の性質

ブラウザのIndexedDBはoriginごとに分かれます。`turbowarp.org`、TurboWarp Desktop、packaged appは
それぞれ別の保存領域で、内容は移動しません。プロファイルを消せば消えます。

したがってIndexedDBは**その端末での再入力を省くためのキャッシュ**であり、バックアップではありません。
正の保存経路はファイルへのexport／importとします。拡張にはすでに`camera calibration JSON`
reporterと`import camera calibration`blockがあるので、運用手順としては会場ごとのフォルダへ
書き出して保管します。

## 未決定: どの拡張が持つか

IndexedDBの読み書きblockはどの拡張も持っていません。選択肢は2つです。

1. 汎用のstorage拡張を新設する。リポジトリ境界の原則（単一拡張で表現できる操作はgeneric extensionへ）
   に沿う。
2. 当面はこのリポジトリが所有する`@multiview-pose/app-shell`拡張に置き、2つ目のアプリが必要とした
   時点で汎用拡張へ昇格する。

2から始めて1へ移すのが現実的です。app shellはすでに各SB3のbundleに入っており、ブラウザAPIを
扱う場所としても自然です。
