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
設計上の必須要件です。詳細は[ポート](#ポート)を参照してください。

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

## ポート

### ポートは設定値ではなく識別子

originは`http://127.0.0.1:<port>`で、**IndexedDBはoriginに紐づきます**。したがってポートを変えると、
保存済みの校正データも演出DSLも別のアプリのものとして扱われ、見えなくなります。

性質としてはextension IDと同じです。[TurboWarp拡張 readiness](extension-readiness.md)でextension IDを
「SB3に保存されるので変更にはmigrationが必要」と扱っているのと同じ重さで管理します。設定ファイルの
チューニング可能な値ではなく、互換性のための固定値です。

tokenはクエリ文字列で渡り、originには含まれません。tokenは起動ごとに変わってよく、保存領域には
影響しません。

### アプリごとに1つ、リポジトリで固定する

camera appとfusion appは別originにします。同じ会場PCで両方を動かしたときに衝突せず、保存内容も
混ざりません。

値は[`config/local-host.json`](../config/local-host.json)で宣言します。
`config/app-extensions.json`（bundle構成）や`config/extension-requirements.json`（readiness要求）と
同じ「リポジトリが所有する固定値」の置き場に揃えるためです。

```json
{
  "schemaVersion": 1,
  "bindHost": "127.0.0.1",
  "portRange": {"minimum": 49152, "maximum": 65535},
  "apps": {
    "camera-app": {"port": 49711, "title": "Multiview Pose Camera App"},
    "fusion-app": {"port": 49712, "title": "Multiview Pose Fusion App"}
  }
}
```

番号はIANAのdynamic/private range（49152〜65535）から取ります。値そのものは任意ですが、一度決めたら
変えない前提です。

`scripts/check-local-host.ts`が`pnpm check`の中で、portが範囲内の整数であること、アプリ間で重複が
ないこと、`config/app-extensions.json`のアプリと過不足なく対応すること、bindHostがloopbackのままで
あることを検証します。アプリを追加したときにportの決定を飛ばせないようにするためです。

`packages/app-shell/src/apps/`には書きません。あちらはブラウザ内で動く拡張の設定で、ポートは
サーバ側の関心事です。

複数のcamera appが同じポート番号を使うのは問題ありません。それぞれ別のPCのloopbackなので衝突せず、
保存領域もPCごとに独立します。ポートを分ける必要があるのは、1台のPCで複数のアプリを動かす場合だけ
です。

### 使用中なら別のポートへ逃げない

起動時にポートが埋まっていた場合、**別のポートを自動で選ばず、理由を表示して終了します**。自動で
逃げると、アプリは起動するのに保存データだけが消えたように見えます。これは「推測した結果を正常値
として表示せずreadinessを失敗にする」という[システム構成](architecture.md)の原則に反します。

エラーには、占有しているポート番号と、保存データがそのポートに紐づいていることを併記します。

### 運用者による上書き

会場のPCで別のソフトウェアと衝突する可能性はあるため、CLIフラグか環境変数での上書き経路は用意
します。ただし上書きしたときは、**保存データが別物になることを起動時に警告します**。黙って通すと、
翌日に「校正が消えた」という形でしか現れません。

上書きして運用を続ける場合は、その会場ではそのポートを固定値として扱います。

### 起動前チェック（`--preflight`）

バイナリは`--preflight`引数で、その会場PCで実際に動くかだけを確認して終了する経路を持ちます。本番の
直前に、アプリを起動せずに機械の状態を確かめるためです。

確認する内容:

- 設定したportが空いているか。埋まっていれば占有している状況を示して失敗し、別のportへは逃げない
- 会場データディレクトリが存在し、読み書きできるか
- 同梱したプレイヤーを取り出せるか
- ブラウザを起動できるか
- 使用するoriginを表示する。運用者が保存領域の同一性を目で確認できる

出力は表示言語の文章にし、失敗時は非ゼロで終了します。

#### preflightで確認できないこと

**IndexedDBの中身は確認できません。** 保存領域はブラウザのプロファイル内にあり、サーバ側のプロセス
からは読めません。「このoriginには何月何日のカメラX、Yの校正がある」という確認は、ページが読み込まれた
後にページ自身が出すしかありません。

したがって、校正やDSLが残っているかどうかの提示はアプリ起動後のreadiness表示の担当で、preflightの
担当ではありません。preflightが保証するのは「起動できる」ところまでです。

#### リポジトリ側の検査との違い

[`scripts/check-local-host.ts`](../scripts/check-local-host.ts)と`--preflight`は別物で、互いの代わりには
なりません。

| | 実行時期 | 確認すること |
|---|---|---|
| `scripts/check-local-host.ts` | CIと開発時 | 宣言が正しいか（portの重複、範囲、アプリとの対応、bindHostがloopback） |
| `--preflight` | 会場、起動直前 | この機械で動くか（portの空き、ディレクトリ、プレイヤー、ブラウザ） |

portの重複は宣言側でしか早く見つけられません。バイナリが気づけるのは「1台のPCで両方のアプリを起動
したとき」だけで、それは会場です。逆にportが今埋まっているかは会場でしか分かりません。同じ理由で、
bindHostがloopbackから外れていないかはreviewで止めるべきもので、会場で気づいても遅すぎます。

### 後退経路とは保存領域が別

素のSB3をTurboWarpで開く後退経路は、`turbowarp.org`やTurboWarp Desktopのoriginで動きます。
ローカルホスト経路の`http://127.0.0.1:<port>`とは別のoriginなので、**両者の間で保存データは移動
しません**。

したがって、後退経路へ切り替えた会場では校正とDSLを入れ直す必要があります。これは
[永続化設計](persistence.md)がIndexedDBをキャッシュと位置づけ、ファイルへのexport／importを正の
保存経路としている理由の1つです。

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
- `--preflight`のport空き確認が、実際の占有と競合しない形で書けるか（確認と本起動の間に奪われる余地）
- `@turbowarp/packager`の出力が、埋め込んだ拡張を含めてloopback配信で正しく動くか
- 固定portのoriginでIndexedDBが期待どおり永続するか
- ad-hoc署名したクロスコンパイル済みバイナリがApple Siliconで起動するか

## 実装しないもの

- `turbowarp-local-preview`は単一ファイルのwatcherしか持ちません。DSL・校正プロファイル・assetと
  複数のソースを監視するなら、watcherを複数持つ設計が要りますが、上位の仕組みは本リポジトリでは
  作らず、必要になった時点でlocal-preview側へ提案します。
- サーバ本体（route定義、watcherの配線、ライフサイクル）は本リポジトリが書きます。local-previewは
  ライブラリであり、CLIを提供しません。
