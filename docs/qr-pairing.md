# QRペアリング（M-07）

camera appとfusion appを、QRコードの往復でWebRTC接続します。搬送形式、part、hash、peerの対応、期限は
[`turbowarp-webrtc-qrcode-pairing`](https://github.com/kubohiroya/turbowarp-webrtc-qrcode-pairing)が
担当し、このリポジトリのscriptは、partを画面に出すこと、運用者のボタン操作を手順に変えること、
結果を表示することだけを担当します（`scripts/app-scripts/pairing.ts`）。

## 操作

| 端末 | 操作 | 画面 |
|---|---|---|
| fusion app | メニュー「カメラアプリと接続する」 | OfferのQRを全画面表示（`Offer（camera-N） i / n`） |
| camera app | カメラを選んでから、メニュー「統合アプリと接続する」 | 投影されたOfferをこのカメラで読み取り、AnswerのQRを全画面表示 |
| 担当者 | AnswerのQRをスマートフォンで撮影し、統合PCへ運ぶ | — |
| fusion app | 「Answerを読み取る」 | 統合PCのカメラのpreviewを出し、スマートフォンのQRを読み取る |
| 両方 | 自動 | 接続後、互いに`twrmc-link-test`を送り、受信したメッセージを表示する |

- QRが複数枚のときは「次のQR」で1枚ずつ進めます。撮影する人のために、自動では巡回しません。
- 「やめる」またはメニュー「接続をやめる」でその交換だけを取り消します。成立済みの接続は切りません。
- fusion appは接続のたびに`camera-1`、`camera-2`…と別のsessionを開くため、別のcamera appの
  Answerが前の交換を完了させることはありません。
- 接続は成立したのに10秒以内に相手のテストメッセージが届かない場合は、エラーとして表示します。

## 構成

- 両SB3はステージだけのprojectなので、partはスプライトではなく、app shellのQRパネル
  （`show QR image [IMAGE] caption [CAPTION] buttons [BUTTONS]`）に、ペアリング拡張が作るdata URIで
  表示します。白地・正方形・非平滑化で、quiet zoneを削りません。
- QRの読取りはペアリング拡張が`turbowarp-jsqr`のruntime capabilityで行い、sessionの間1つのcamera leaseを
  保持します。アプリはjsQRの結果をruntime variableで受け取らないため、Temporary Variables拡張への
  依存（#19）はこの経路にはありません。
- WebRTCはcapability v3が必要なため、`turbowarp-webrtc`を0.4.0へ上げています。

## feature flagと切戻し

`qrCourierPairing`（起動時固定）が両アプリで有効のときだけメニューに現れます。app shellはこの値を
ペアリング拡張の`__TWQP_FEATURE_FLAGS__.qrCodePairing`へも書きます。切り戻すときは
`packages/app-shell/src/apps/*.ts`の`featureFlags`から外してビルドし直します。ペアリング拡張の
ブロックが消え、manual pairing（`turbowarp-webrtc`の`create offer code`など）が残ります。

## 検証の状況

- 自動：`pnpm check`（app shellのQRパネル・フラグのテストを含む）。
- ブラウザ：ローカルホストで両アプリを別originに配信し、fusion appのOffer作成からcamera appのAnswer表示、
  fusion appでの接続成立、双方向のテストメッセージ、取消までをメニュー操作で通した。ただし
  ブラウザペインではカメラを使えないため、QRの読取りは表示中の画像をページ内でjsQRにかけ、
  読み取った文字列を`receive pairing QR text`へ渡して代替した。
- 未確認：実カメラでの読取り、プロジェクタ投影とスマートフォン撮影、別PC間のICE、複数part。
