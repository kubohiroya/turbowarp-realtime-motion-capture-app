# ローカルホストによる配布と運用（設計中）

> [!NOTE]
> 方針の検討結果です。実装はまだありません。未検証の項目を「未検証」として明示しています。

配布SB3をTurboWarpで開く運用には、ホストページを誰も所有していないという問題があります。この文書は、
`@kubohiroya/turbowarp-local-preview`を使って会場PCごとにloopback HTTPホストを立て、そこからアプリを
配信する構成を検討した結果です。

## なぜホストページが要るか

3つの問題が同時に解けます。

| 問題 | ホストページがあると |
|---|---|
| feature flagの注入先 | `http://127.0.0.1:<port>` を自分たちのoriginとして所有できる |
| 設定の永続化 | originが安定するので、IndexedDBの内容が次回起動時に残る |
| 演出DSLの読み込み | ファイル監視とServer-Sent Eventsで、編集がその場で反映される |
| 校正データの保存先 | ホストのrouteでディスクへ書けるので、ブラウザ保存を本当にキャッシュへ降格できる |
| 通信の制約 | 同一originなので mixed content、CORS、Private Network Access の許可がすべて無関係になる |

最後の1つが決定的です。`turbowarp.org`のページからlocalhostのサーバを叩く構成は、ブラウザの
mixed content制限とローカルネットワークアクセスの許可プロンプトに正面からぶつかります。ホストが
ページごと配信すれば、そもそも別originを跨ぎません。

## local-previewのモデル

このライブラリは「ページを取りに行く」のではなく「ページを配る」設計です。`/`がHTMLを返し、その
ページが同一originの`/events`をSSEで購読します。token認証があり、loopbackにしかbindしません。

```text
会場PC
┌─────────────────────────────────────────────┐
│ 単体バイナリ                                │
│  ├ loopback HTTP host (127.0.0.1:<固定port>)│
│  │   ├ /            アプリのページ          │
│  │   ├ /events      SSE（DSL更新の通知）    │
│  │   └ /api/...     校正データの保存・読出  │
│  └ file watcher（performance DSL）          │
└──────────────────┬──────────────────────────┘
                   │ 同一origin
              ブラウザ
              ┌──────────────────────────┐
              │ TurboWarp VM + SB3       │
              │  IndexedDB（originに紐付）│
              └──────────────────────────┘
```

## 決定事項

### portは固定する

`createLoopbackPreviewHost`の`port`既定値は`0`で、毎回別のポートになります。originにはポートが
含まれるため、**そのままではIndexedDBが毎回別の保存領域になり、キャッシュが消えます**。portの固定は
設計上の必須要件です。

### feature flagはホストページで設定しない

flagの注入はSB3のstatic bundleが担当したままにします。bundleのmember順という機構が両方の配布経路で
同じように効くため、機構を1つに保てます。ホストページ側でも設定すると、SB3内のシェルが後から
上書きするだけで、経路が増える分だけ壊れやすくなります。

### 素のSB3を後退経路として残す

ローカルホストを主経路にしますが、会場でバイナリが起動しない場合に何も出せないのは避けます。
static bundleによってSB3は自己完結しているので、後退経路の維持コストはありません。

### プレイヤーは事前ビルドして同梱する

ホストはTurboWarpのVMを持っていません。`tm-kamishibai`は実行時にViteで`scratch-vm`をバンドルして
いますが、Viteはネイティブバイナリと動的なプラグイン解決に依存するため、単体バイナリの中で走らせるのは
現実的ではありません。**`@turbowarp/packager`の出力（自己完結HTML）をリリース時に作り、静的routeで
配信する**方針とします。

## 単体バイナリ

Node.jsを会場の全PCへインストールする運用を避けるため、ランタイムを同梱した単体実行ファイルにします。

| | Bun | Deno |
|---|---|---|
| Node API互換 | 高い | 良好だが穴がある |
| コマンド | `bun build --compile --target=bun-<os>-<arch>` | `deno compile --target` |
| 権限モデル | なし | `--allow-net=127.0.0.1:<port>`などを焼き込める |
| サイズ | 50〜100MB程度 | 80〜120MB程度 |

`turbowarp-local-preview`は`node:http` / `node:fs` / `node:crypto` / `node:net` / `node:stream`で
書かれているため、**Bunの方がそのまま動く確率が高く、第一候補**とします。Denoの権限モデルは、会場の
ファイルを読み書きしローカルサーバを開くアプリの範囲を宣言的に絞れる点で優れているので、互換性の
問題が出ないと確認できた場合の対案とします。

この選択は低リスクかつ可逆です。バイナリの仕事はHTTPサーバとファイル監視だけで、重い処理
（TurboWarp VM、姿勢推定、3D統合）はすべてブラウザ側で動きます。

## 署名

**署名は必須ではありません。必要になるかどうかは配布経路で決まります。**

### macOS

- Gatekeeperの警告が出るのは`com.apple.quarantine`属性が付いているときだけです。この属性を付けるのは
  ブラウザ、メール、AirDropです。**USBメモリやファイル共有でコピーした場合は付きません**。
- ただしApple Siliconでは、署名のない実行ファイルはそもそも起動できません。`codesign -s -`による
  ad-hoc署名が必要ですが、これは**無料**です。クロスコンパイルしたmacOS向けバイナリには自分で
  当てる必要があります。ad-hoc署名はGatekeeperのダウンロード警告を消すものではありません。
- Webからダウンロードさせる形にして警告を消すには、Developer ID署名とnotarizationが必要で、
  **Apple Developer Program（年額$99程度）への加入が要ります**。無料のApple IDでは取得できません。

### Windows

- SmartScreenの警告が出ますが、「詳細情報 → 実行」で通せます。
- 消すにはコード署名証明書が必要です。2023年6月以降は秘密鍵をハードウェアトークンかHSMに置く必要が
  あり、年額はOVで$200〜400、EVで$300〜600程度が目安です。

### この案件の方針

会場へUSBやファイル共有で持ち込む運用なら、**macOSのad-hoc署名（無料）だけで足ります**。一般公開して
Webからダウンロードさせる段階になったら、Apple Developer Programを検討します。

## 未検証の項目

実装前に確認が必要です。

- `turbowarp-local-preview`がBunの`node:`互換でそのまま動くか
- `@turbowarp/packager`の出力が、埋め込んだ拡張を含めてloopback配信で正しく動くか
- 固定portのoriginでIndexedDBが期待どおり永続するか
- ad-hoc署名したクロスコンパイル済みバイナリがApple Siliconで起動するか

## 実装しないもの

- `turbowarp-local-preview`は単一ファイルのwatcherしか持ちません。DSL・校正プロファイル・assetと
  複数のソースを監視するなら、watcherを複数持つ設計が要りますが、上位の仕組みは本リポジトリでは
  作らず、必要になった時点でlocal-preview側へ提案します。
- サーバ本体（route定義、watcherの配線、ライフサイクル）は本リポジトリが書きます。local-previewは
  ライブラリであり、CLIを提供しません。
