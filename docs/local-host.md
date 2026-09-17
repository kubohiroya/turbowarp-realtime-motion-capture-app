# ローカルホストによる配布と運用（設計中）

> [!NOTE]
> ホスト、CLI、プレイヤー生成、バイナリ化まで実装済みで、実機で動作を確認しています。
> 未検証の項目を「未検証」として明示しています。

配布SB3をTurboWarpで開く運用には、ホストページを誰も所有していないという問題があります。この文書は、
`@kubohiroya/turbowarp-local-preview`を使って会場PCごとにloopback HTTPホストを立て、そこからアプリを
配信する構成を検討した結果です。

## 会場に何を持ち込むか

|          | 必要なもの                    | 誰の環境   |
| -------- | ----------------------------- | ---------- |
| ビルド時 | Node.js、pnpm、このリポジトリ | 開発機とCI |
| 会場     | **単体バイナリ1つだけ**       | 運用者のPC |

会場にNode.jsは要りません。`scripts/`配下の検査はリポジトリの設定ファイルを読むものなので、会場には
実行対象がそもそも存在しません。ビルド側はSB3の生成に`sb3-toolchain`を、シェルのビルドにViteを使うため
Node.jsが前提ですが、それは会場に持ち出されません。

## なぜホストページが要るか

3つの問題が同時に解けます。

| 問題                 | ホストページがあると                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| feature flagの注入先 | `http://127.0.0.1:<port>` を自分たちのoriginとして所有できる                            |
| 設定の永続化         | originが安定するので、IndexedDBの内容が次回起動時に残る                                 |
| 演出DSLの読み込み    | ファイル監視とServer-Sent Eventsで、編集がその場で反映される                            |
| 校正データの保存先   | ホストのrouteでディスクへ書けるので、ブラウザ保存を本当にキャッシュへ降格できる         |
| 通信の制約           | 同一originなので mixed content、CORS、Private Network Access の許可がすべて無関係になる |

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

## レンズ校正アプリの同梱

camera appのホストは、`/lens-calibration`でレンズ校正アプリ（`turbowarp-camera-calibration-app`）の
プレイヤーも配信できます。校正アプリが解いたprofileをIndexedDBへ保存し、camera appがそこから復元する
ため、両者は同じoriginでなければなりません。

校正アプリにはまだ公開artifactが無いため、SB3は`config/local-host.json`の`lensCalibration.sb3`
（`apps/camera-app/local/lens-calibration.sb3`、Git管理外）へ手で置きます。`build:player`は、置かれていれば
SHA-256を表示して`camera-app-lens-calibration-player.html`を作り、`build:binary`はそれを同梱します。
無ければ警告して続行し、camera appは「校正アプリを開けない」と表示してファイルの読込みを案内します。

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

#### 実測（`@turbowarp/packager` 3.13.0）

両アプリのSB3をpackagerに通し、生成したHTMLを実ブラウザで読み込んで確認しました。

| アプリ     | SB3    | 生成HTML | 実VMで読み込まれた拡張           |
| ---------- | ------ | -------- | -------------------------------- |
| camera app | 6.1 MB | 27.1 MB  | `realtimemotioncapturecameraapp` |
| fusion app | 6.3 MB | 27.8 MB  | `realtimemotioncapturefusionapp` |

確認できたこと。

- **feature flagが実VMでも正しく適用される。** camera appでは`webgpuMoveNetMultiPose`など5つ、
  fusion appでは`qrCourierPairing`など6つが有効で、それぞれの宣言と一致します。static bundleの
  member順による注入が、スタブではなく実際のTurboWarp runtimeで機能しています
- **パレットが1つに統合される。** fusion appで211項目（うち実ブロック183）。app shell、title-menu、
  契約拡張のすべてが`<memberId>__`付きで並びます
- **読み込み時の外部リクエストがゼロ。** HTML本体とblob URLだけで、完全に自己完結しています
  （MoveNetのmodelはあとで取得するため、そちらは別問題です）

#### 落とし穴: `options.extensions`を渡さないと拡張が黙って消える

**packagerは`options.extensions`に入っていない埋め込み拡張を、警告なく取り除きます。**

既定のまま実行すると9.1 MBのHTMLが生成され、ページは正常に開き、VMも起動し、プロジェクトも
読み込まれます。しかし`extensionURLs`は空で、拡張は1つも読み込まれません。エラーもコンソール出力も
ありません。

`loadProject`が返す`analysis.extensions`に検出済みのdata URLが入っているので、これを渡します。

```js
const project = await Packager.loadProject(data);
const packager = new Packager.Packager();
packager.project = project;
packager.options.target = 'html';
packager.options.extensions = project.analysis.extensions;
```

これでHTMLは27 MBになり、拡張が読み込まれます。**サイズが3倍近く変わるので、ビルド側で出力サイズの
下限を検査すれば取り違えを機械的に防げます。**

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
  "apps": {
    "camera-app": { "port": 49711, "title": "Multiview Pose Camera App" },
    "fusion-app": { "port": 49712, "title": "Multiview Pose Fusion App" }
  }
}
```

番号はIANAのdynamic/private range（49152〜65535）から取ります。値そのものは任意ですが、一度決めたら
変えない前提です。

bind先は設定項目にしません。`createLoopbackPreviewHost`の型が`'127.0.0.1' | '::1'`しか受け付けず、
`validateLoopbackPreviewUrl`もloopback以外のURLを拒否するため、loopback以外を選ぶ方法がありません。
選べない項目を設定ファイルに書くと、選べるかのような誤解を生みます。

`packages/app-shell/src/apps/`には書きません。あちらはブラウザ内で動く拡張の設定で、ポートは
サーバ側の関心事です。

複数のcamera appが同じポート番号を使うのは問題ありません。それぞれ別のPCのloopbackなので衝突せず、
保存領域もPCごとに独立します。ポートを分ける必要があるのは、1台のPCで複数のアプリを動かす場合だけ
です。

### 起動時に確かめ、駄目なら止まる

ポートまわりの確認の主機構は**バイナリの起動時チェック**です。設定されたポートで待ち受けられるか
試し、駄目なら理由を表示して非ゼロで終了します。**別のポートを自動で選ぶことはしません。** 自動で
逃げると、アプリは起動するのに保存データだけが消えたように見えます。これは「推測した結果を正常値
として表示せずreadinessを失敗にする」という[システム構成](architecture.md)の原則に反します。

エラーには、占有しているポート番号と、保存データがそのポートに紐づいていることを併記します。
**誰が占有しているかは推測せず、run lockで確定させます**（[占有元の特定](#占有元の特定)）。

ポートが未設定、範囲外、占有済みといった不備は、すべてこの起動時チェックが明確な失敗として報告
します。リポジトリ側で先回りして検査する必要はありません。

### 占有元の特定

「ポートが使えない」だけでは運用者は動けません。次にすべきことが、原因ごとに違うからです。

| 原因                                     | 運用者がすべきこと                               |
| ---------------------------------------- | ------------------------------------------------ |
| 同じアプリが既に起動している             | 起動済みのウィンドウへ戻る。2つ目を起動しない    |
| もう一方のアプリが同じポートを持っている | 設定の割り当てが重複している。ビルドを直す       |
| 無関係なプログラムが使っている           | そのプログラムを止めるか、上書きで別ポートを使う |

そこで、**推測ではなくrun lockで判別します**。起動しているホストは、ユーザー単位のruntime
ディレクトリ（`XDG_RUNTIME_DIR`、無ければOSのtemp配下の`multiview-pose/`）へ、自分のlockファイルを
置きます。実装は[`packages/local-host/src/run-lock.ts`](../packages/local-host/src/run-lock.ts)に
あります。`acquireRunLock`が起動時のlock取得を、`findPortHolder`がbind失敗後の占有元特定を担当
します。

```json
{
  "app": "camera-app",
  "port": 49711,
  "origin": "http://127.0.0.1:49711",
  "pid": 41234,
  "startedAt": "2026-09-14T09:12:04.001Z"
}
```

tokenは書きません。認証情報をディスクへ残さない方針は、pairing credentialと同じ扱いにします。

起動手順は次の順です。

1. 自分のlockを`wx`（排他生成）で作る。既にあれば、そのlockのプロセスが生きているか確認する
2. ポートをbindする
3. 終了時（シグナル受信を含む）にlockを消す

判定はこうなります。

- **自分のlockがあり、そのプロセスが生きている** → 「このアプリは既に起動しています（pid、起動時刻、
  origin）」。確定情報なので「可能性」とは書きません
- **自分のlockがあるが、プロセスが死んでいる** → 前回の異常終了。lockを消して続行します
- **bindが`EADDRINUSE`で、他アプリのlockがこのポートを名乗っていて、そのプロセスが生きている** →
  「ポート49711はfusion appが使用中です」と、アプリ名を確定して表示します。あわせて
  `config/local-host.json`の割り当てが重複していることを指摘します
- **bindが`EADDRINUSE`だが、該当するlockが無い** → 「別のプログラムが使用中です」。ここで
  Realtime Motion Captureアプリの名前を出すことはしません。分からないものを分かったように書かないためです

pidは再利用されうるので、生死だけでは足りません。**lockが主張するポートが実際にbindできない**ことを
併せて確認し、両方が揃ったときにだけ「生きている」と判断します。逆にlockはあるがポートが空いている
場合は、stale lockとして扱います。

プロセスの生死とポートの占有はどちらも差し替え可能な関数として受け取るので、テストは実際のプロセスや
ポートを用意せずに全分岐を動かせます。既定の実装そのものは、実際にポートをlistenするテストで
確認します。

### 運用者による上書き

会場のPCで別のソフトウェアと衝突する可能性はあるため、CLIフラグか環境変数での上書き経路は用意
します。ただし上書きしたときは、**保存データが別物になることを起動時に警告します**。黙って通すと、
翌日に「校正が消えた」という形でしか現れません。

上書きして運用を続ける場合は、その会場ではそのポートを固定値として扱います。

### `--preflight`は同じ確認を実行して終了するだけ

`--preflight`引数は別の仕組みではありません。**通常起動と同じ確認を行い、アプリを起動せずに終了する**
モードです。本番の直前に、アプリを立ち上げずに機械の状態だけ確かめるために使います。

確認する内容は通常起動と同じです。

- 設定したポートで待ち受けられるか
- 会場データディレクトリが存在し、読み書きできるか
- 同梱したプレイヤーを取り出せるか
- ブラウザを起動できるか

あわせて、使用するoriginを表示します。運用者が保存領域の同一性を目で確認できるようにするためです。
出力は表示言語の文章にし、失敗時は非ゼロで終了します。

#### preflightで確認できないこと

**IndexedDBの中身は確認できません。** 保存領域はブラウザのプロファイル内にあり、サーバ側のプロセス
からは読めません。「このoriginには何月何日のカメラX、Yの校正がある」という確認は、ページが読み込まれた
後にページ自身が出すしかありません。

したがって、校正やDSLが残っているかどうかの提示はアプリ起動後のreadiness表示の担当で、preflightの
担当ではありません。preflightが保証するのは「起動できる」ところまでです。

#### リポジトリ側では検査しない

設定の不備は起動時チェックが明確な失敗として報告するので、リポジトリ側に同じ検査は置きません。

ポートの重複も同じです。1台のPCで2つ目のアプリを起動したときに止まり、run lockによって
**どちらのアプリが持っているかまで確定して**報告されます（[占有元の特定](#占有元の特定)）。別々の
PCで同じ番号を使うのはそもそも問題ではありません。

ただし運用上の帰結として、同じPCで2つのアプリに同じ番号を使い回すと、同時に起動できないだけでなく、
**両者が同じoriginを共有するため保存領域も共有します**。アプリごとに別の番号を割り当てているのは
このためです。

### 後退経路とは保存領域が別

素のSB3をTurboWarpで開く後退経路は、`turbowarp.org`やTurboWarp Desktopのoriginで動きます。
ローカルホスト経路の`http://127.0.0.1:<port>`とは別のoriginなので、**両者の間で保存データは移動
しません**。

したがって、後退経路へ切り替えた会場では校正とDSLを入れ直す必要があります。これは
[永続化設計](persistence.md)がIndexedDBをキャッシュと位置づけ、ファイルへのexport／importを正の
保存経路としている理由の1つです。

## 実装状況

[`packages/local-host/src/host.ts`](../packages/local-host/src/host.ts)の`startLocalHost`が、この文書の
起動シーケンスを実装しています。

1. プレイヤーを読む（無ければlockを取る前に失敗する）
2. run lockを取る（取れなければ`already-running`）
3. 固定ポートでbindする（`EADDRINUSE`ならlockを解放し、占有元を特定して分類する）
4. DSLのwatcherを開始し、SSEへ流す

`/app`でプレイヤーを配信し、ホストの`/`は`/app`へtokenごとredirectします。接続時には必ず1件emitする
ので、DSLを一度も変更していないページでもストリームが開きます。

失敗は運用者が次にとる行動ごとに分かれます。

| 戻り値                     | 意味                                               |
| -------------------------- | -------------------------------------------------- |
| `already-running`          | 同じアプリが起動中。holderにpidと起動時刻が入る    |
| `port-held-by-application` | もう一方のアプリが占有。**アプリ名が確定している** |
| `port-unavailable`         | lockが無い。アプリ名は出さない                     |
| `player-missing`           | プレイヤーが読めない。lockを取る前に失敗する       |

### リリースの手順

```bash
pnpm build                # SB3を生成する
pnpm run build:player     # SB3 -> 自己完結プレイヤーHTML
pnpm run build:binary     # プレイヤーを同梱した単体バイナリ
```

`build:binary`はbunをPATHに要求し、無ければインストール先を示して失敗します。リポジトリの依存には
していません。会場に要るのはバイナリだけで、ビルド機だけがbunを必要とするためです。
`--target=bun-windows-x64`のように渡せばクロスコンパイルします。

バイナリのエントリは`scripts/build-binary.ts`が生成します。ポートとタイトルは
`config/local-host.json`から、プレイヤーは隣のHTMLから取るので、手で書く余地を残しません。ポートが
3箇所目で食い違う事故を防ぐためです。

### 運用者向けの引数

| 引数          | 動作                                                                 |
| ------------- | -------------------------------------------------------------------- |
| なし          | 起動してブラウザを開く                                               |
| `--preflight` | 同じ起動処理を行い、ブラウザを開かずに終了する                       |
| `--no-open`   | 起動するがブラウザは開かない。既にウィンドウがある場合と、自動確認用 |

起動できなければ非ゼロで終了します。スクリプトから「起動しなかった」ことを判別できる必要があるため
です。

### 通しの実測

パッケージ済みのcamera app（27.1 MB）を`startLocalHost`で配信し、ブラウザで読み込みました。

- origin は `http://127.0.0.1:49711`。宣言した固定ポートのとおり
- 合成拡張`realtimemotioncapturecameraapp`が実VMで読み込まれ、feature flagも5つ有効
- **IndexedDBに書いた内容が、ホストを再起動しても残る。** 再起動でtokenは変わりましたが、tokenは
  クエリでoriginに含まれないため保存領域に影響しません。固定ポートがoriginを安定させるという前提が
  実測で確認できました
- ホストはNodeとBunで同一に動作します（起動、配信、401、DSLの初回publishと追随、二重起動の拒否、停止）

ビルドしたバイナリ（114 MB）でも同じことを確認しました。

- `--preflight`が合格して終了コード0
- `--no-open`で起動し、埋め込んだ28.4 MBのプレイヤーを`/app`から配信
- 2つ目の起動が「このアプリは既に起動しています（pid、起動時刻）」で拒否され、**終了コード1**
- 起動中の`--preflight`も終了コード1

## 単体バイナリ

Node.jsを会場の全PCへインストールする運用を避けるため、ランタイムを同梱した単体実行ファイルにします。

**Bunを採用します。** `turbowarp-local-preview`が`node:http` / `node:fs` / `node:crypto` /
`node:net` / `node:stream`で書かれているため互換性が論点でしたが、実測で解決しました。

### 実測（Bun 1.4.2、macOS arm64）

`turbowarp-local-preview` 0.1.0に対して9項目を確認し、**Node 26と同一の結果（9/9）**でした。

- loopback hostの起動、hostページの配信
- tokenなしのリクエストを401で拒否
- アプリ定義routeの配信、lifecycle snapshot
- SSEの接続とイベント配信
- file watcherの初回publishと、ディスク上の変更への追随

`bun build --compile`も期待どおり動きます。

| target                       | サイズ | 備考                          |
| ---------------------------- | ------ | ----------------------------- |
| `bun-darwin-arm64`（native） | 60 MB  | 上記9項目をバイナリのまま通過 |
| `bun-darwin-x64`             | 66 MB  | cross-compile。署名あり       |
| `bun-linux-x64`              | 78 MB  | cross-compile                 |
| `bun-windows-x64`            | 82 MB  | cross-compile                 |

**`bun build --compile`はad-hoc署名を自動で付けます**（`flags=0x20002(adhoc,linker-signed)`）。
Apple Siliconが要求する「無署名の実行ファイルは起動できない」条件は、追加作業なしで満たされます。
Gatekeeperのダウンロード警告は別の話で、これは消えません（[署名](#署名)を参照）。

Denoは対案として残します。権限モデル（`--allow-net=127.0.0.1:<port>`など）を焼き込める点は優れて
いますが、Bunで動くと分かった以上、いま乗り換える理由はありません。

この選択は低リスクかつ可逆です。バイナリの仕事はHTTPサーバとファイル監視だけで、重い処理
（TurboWarp VM、姿勢推定、3D統合）はすべてブラウザ側で動きます。

### 実測で判明した実装上の要件

`createLoopbackPreviewHost`は、**書き込みが発生するまでSSEのヘッダをflushしません**。保持イベントが
無い状態でEventSourceが接続すると、最初のイベントが来るまで接続が開いたことになりません。

したがってホスト実装は、**接続直後に必ず1つ書き込みます**（コメント行かheartbeat）。そうしないと、
DSLを一度も変更していない起動直後のページが、接続できているのかどうか判別できません。

## 署名

**署名は必須ではありません。必要になるかどうかは配布経路で決まります。**

### macOS

- Gatekeeperの警告が出るのは`com.apple.quarantine`属性が付いているときだけです。この属性を付けるのは
  ブラウザ、メール、AirDropです。**USBメモリやファイル共有でコピーした場合は付きません**。
- Apple Siliconでは署名のない実行ファイルはそもそも起動できませんが、**`bun build --compile`が
  ad-hoc署名を自動で付ける**ことを実測で確認しました（cross-compileしたdarwin-x64も署名あり）。
  追加作業は要りません。ad-hoc署名はGatekeeperのダウンロード警告を消すものではありません。
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
- 起動時のポート確認と実際の待ち受け開始の間に他プロセスへ奪われる余地をどう扱うか
- run lockの置き場が、対象OSすべてでユーザー単位に分離されているか（共有tempのパーミッション）
- hatの発火とUI overlayが、packager化したruntimeでも動くか（拡張の読み込みとパレット生成までは確認済み）
- ad-hoc署名したクロスコンパイル済みバイナリがApple Siliconで起動するか

## 実装しないもの

- `turbowarp-local-preview`は単一ファイルのwatcherしか持ちません。DSL・校正プロファイル・assetと
  複数のソースを監視するなら、watcherを複数持つ設計が要りますが、上位の仕組みは本リポジトリでは
  作らず、必要になった時点でlocal-preview側へ提案します。
- サーバ本体（route定義、watcherの配線、ライフサイクル）は本リポジトリが書きます。local-previewは
  ライブラリであり、CLIを提供しません。

## 録画の保管（/recordings）

ポーズの録画（`twrmc/pose-3d-session` v1）を、会場のPCのディレクトリに置きます。アプリごとにポートが
違ってもディレクトリは同じなので、camera appで録った録画をfusion appで再生できます。

| メソッド                         | 内容                                        |
| -------------------------------- | ------------------------------------------- |
| `GET /recordings`                | 一覧（名前、バイト数、更新時刻）            |
| `GET /recordings?name=<名前>`    | 読み出し                                    |
| `PUT /recordings?name=<名前>`    | 書き込み（JSONでない本文は拒否、64 MBまで） |
| `DELETE /recordings?name=<名前>` | 削除                                        |

名前は英数字と`.`・`-`・`_`で、`.json`で終わるものだけを受け付けます。区切り文字も先頭のドットも
受け付けないので、ディレクトリの外は指せません。ほかの経路と同じくトークンが要ります。

置き場所は`TWRMC_RECORDINGS`、既定はホームの`multiview-pose-recordings`です。
