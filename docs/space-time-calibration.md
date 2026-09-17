# 空間と時刻の校正（M-08）

fusion appが投影する1つの時刻パターンで、各カメラの時刻対応と配置を同時に校正します。推定器、
四隅の検出、配置solveは[`turbowarp-time-space-sync`](https://github.com/kubohiroya/turbowarp-time-space-sync)
0.2.0が担当し、このリポジトリのscript（`scripts/app-scripts/space-time.ts`）はメッセージの受け渡し、
品質の閾値、表示だけを担当します。

## 前提

- 各camera appでカメラを選び、レンズ校正が適用済みであること（保存済みの復元、校正アプリ、ファイル）。
- M-07のQRペアリングで、全camera appがfusion appに接続済みであること。
- 各カメラが投影面全体を、正立（ロール±45°以内）かつ鏡像でない向きで見ていること。

## 操作

| 端末 | 動作 |
|---|---|
| fusion app | メニュー「空間と時刻を校正する」。明滅の警告に同意すると、`twtss.pattern.v2`のパターンを全画面に投影する |
| fusion app → 全camera app | `twrmc-sync-start`（基準ID、fusion PCが測ったrefresh間隔、測定秒数）を送る |
| camera app | デコーダを校正し、四隅を測定し、時刻対応を推定して、結果を`twrmc-sync-result`で返す。レンズ校正が無いなどで測定できない場合も理由を返す |
| 担当者 | 投影中に、パターンの外側の四隅（点灯している角のセルの外側の角）を巻尺で測る |
| fusion app | 全員の返信を受け取るとパターンを消し、四隅の実寸（m）の入力を求める。前回の値が既定値になる |
| fusion app | 基準を定義し、各カメラのカメラモデルと観測を追加して配置をsolveし、READYを判定する |

camera appが返すカメラモデルはtime-space-syncの`camera model JSON for [pose]`で、歪み係数を含みます
（Camera Sourceの`camera intrinsics JSON`は歪みを含まないため、solveが拒否します）。fusion appは各観測の
`cameraId`をペアリング時のpeer名（`camera-1`など）に置き換えます。camera appは全員`pose`を使うためです。

## READYの条件

すべてを満たすときだけREADYを表示し、満たさない項目をカメラごとに列挙します。閾値は実機記録の前に決めた
初期値で、`scripts/app-scripts/space-time.ts`の`thresholds`にあります。

| 項目 | 閾値 |
|---|---|
| 全camera appから返信がある | 60秒以内 |
| 測定に成功している（`status: measured`） | — |
| 時刻対応の不確かさ | 10 000 µs以下、`degraded`でない |
| 四隅のばらつき | 0.5 px以下（拡張自身も超えると拒否する） |
| 配置solve | エラーなし、`degraded`でない |
| 再投影誤差RMS | 2 px以下 |

## 構成上の注意

- 各アプリのWebRTC受信キューは1つの受信scriptだけが読み、種類ごとに変数やリストへ振り分けます
  （`scripts/app-scripts/network.ts`）。ペアリングのテストメッセージも同じ経路です。
- app shellは`__TWTSS_FEATURE_FLAGS__`（`opticalTimeSyncV1`、`placementSolveV1`）を、アプリ設定の
  `timeSpaceSync`から書きます。旧経路の`frameSyncPatternV1`は二重の表示・補正を避けるため両アプリで無効にしました。
- JSONの読み書き、確認ダイアログ、数値フォームはapp shellの汎用blockです。

## 検証の状況

- 自動：`pnpm check`。time-space-sync 0.2.0側で、合成画像による四隅精度（1280x720・ぼけ・ノイズで最悪0.1px未満）と、
  四隅→観測→基準→solveで2台の姿勢を1.3mm・0.03°以内に復元するテスト。
- ブラウザ：ローカルホストで両アプリを配信し、ペアリング後にfusion appのメニューから、警告・投影・開始メッセージ・
  返信・四隅入力・solve・READY判定まで通した。ブラウザペインはカメラを使えないため、camera app側の
  デコーダと四隅測定のblockを、既知の姿勢から射影した合成観測を返すものに置き換えた。solveは合成時の
  カメラ位置（-0.784, -0.442, 2.884 m）を再現し、READYになった。不確かさ20 000 µsとばらつき0.9 pxでは
  両項目を挙げてREADYにならず、レンズ未校正のカメラは理由を返してREADYにならないことを確認した。
- 未確認：実カメラでの復号と四隅測定、プロジェクタ投影、複数台、実測寸法での配置誤差の検証。
