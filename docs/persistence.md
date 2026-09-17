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

| データ                                    | 再利用               | 理由                                                                               |
| ----------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| レンズintrinsic／distortion               | 再利用する           | カメラとレンズに固有で、動かしても変わらない                                       |
| `worldFromCameraMatrix`（外部パラメータ） | 参考値として提示する | カメラを動かした瞬間に無効。復元時は「動かしていない」ことの確認か再校正を要求する |
| カメラ選択（`deviceId`）                  | ヒントとしてのみ使う | `deviceId`はブラウザとプロファイルに固有で変わる。deviceラベルと解像度で照合する   |
| フレーム遅延・時刻offset                  | 毎回測り直す         | 露出、プロジェクタ、負荷で変わる。復元すると静かにタイミングが狂う                 |

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
正の保存経路はファイルへのexport／importとします。ファイルはレンズ校正アプリが書き出すROSの
`camera_info` YAML（下記）で、運用手順としては会場ごとのフォルダへ書き出して保管します。

## camera appのレンズ校正の入口（実装済み）

camera appは、カメラが動き始めた直後にレンズ校正を確かめます。

1. `restore stored camera profile for [pose]`で、このoriginのIndexedDBに保存された校正を新しい順に
   調べ、今のカメラに`compatible`なものだけを登録します。使ったときはどの校正かを通知に表示し、
   メニューからいつでも校正し直せます。`incompatible`／`undetermined`は適用せず、理由を表示します。
2. 保存済みが無い、または合わないときは、メニューの次のどちらかを選びます。
   - **レンズ校正アプリで校正する**：camera appはカメラを手放し、同じoriginの`/lens-calibration`
     （ローカルホストが配信）を別ウィンドウで開きます。校正アプリが解いたprofileをIndexedDBへ保存すると、
     `stored camera profiles generation`がBroadcastChannel経由で増えるので、camera appはそれを待って
     同じdeviceでカメラを再開し、1.を繰り返します。ウィンドウが閉じられた場合も再開します。
   - **レンズ校正ファイルを読む**：ダイアログのボタンからファイルを選び、`register camera profile ... as [pose]`
     で登録します。合わなければ登録を取り消します。合えばIndexedDBへも保存し、次回の読込みを省きます。

レンズ校正ファイルは、レンズ校正アプリが書き出すROSの`camera_info` YAMLです（camera-source 0.11.0以降）。
標準の部分はROSやOpenCV系のツールもそのまま読み、ROSに置き場の無い校正日時・撮影条件・品質は
`turbowarp_camera_source`の項目に入ります。TurboWarpはリストの書き出しを`profile.txt`として保存するので、
ファイル選択は`.txt`／`.yaml`／`.yml`／`.json`を受け付けます。形式の判別はcamera-sourceがテキストから行います。
`packages/app-shell/tests/lens-calibration-file.test.ts`は、校正アプリの契約fixtureを、camera appが埋め込む
camera-sourceのバンドルに、この入口と同じ順序で読ませて確かめます。

同じoriginであることが前提です。turbowarp.orgやファイルで開いたSB3には校正アプリが並んでいないため、
「開けない」と表示してファイルの読込みを案内します。

上の「無言のauto-applyにはしません」は、次の形に置き換えました。確認の操作は求めませんが、
`compatible`と判定されたものだけを使い、使った校正のprofile IDと校正日時を通知に表示します。

## どの拡張が持つか（決定）

保存・復元のblockは`@kubohiroya/turbowarp-camera-source`（0.10.0以降）が持ちます。profile契約と
互換性判定の持ち主であり、校正アプリとcamera appの両方に埋め込まれているため、DB名・store・keyの
契約を1か所に置けます。app shellが持つのは、校正アプリのウィンドウとファイル選択ダイアログだけです。

以下は決定前の検討記録です。

## 検討記録: どの拡張が持つか

IndexedDBの読み書きblockはどの拡張も持っていません。選択肢は2つです。

1. 汎用のstorage拡張を新設する。リポジトリ境界の原則（単一拡張で表現できる操作はgeneric extensionへ）
   に沿う。
2. 当面はこのリポジトリが所有する`@turbowarp-realtime-motion-capture-app/app-shell`拡張に置き、2つ目のアプリが必要とした
   時点で汎用拡張へ昇格する。

2から始めて1へ移すのが現実的です。app shellはすでに各SB3のbundleに入っており、ブラウザAPIを
扱う場所としても自然です。
