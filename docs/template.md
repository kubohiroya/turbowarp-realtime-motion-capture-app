# テンプレートとの関係

本リポジトリは[turbowarp-app-template](https://github.com/kubohiroya/turbowarp-app-template)の構成に
従います。ただし生成された雛形ではありません。テンプレート側の共通構成は紙芝居アプリと本リポジトリ
から抽出されたもので、本リポジトリはその後からテンプレートの構成を取り込みました。この文書は、
どこを揃え、どこを意図的に変えているかを記録します。

アプリ全体の目的と現在の状態は[README](../README.md)、ディレクトリと開発手順は
[SB3開発ガイド](repository-layout.md)を参照してください。

## テンプレートから取り込んだもの

| 対象                                                       | 内容                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `config/app.json`                                          | 名前、モード、説明、実装予定、依存の宣言。英語READMEの訳文は`en`に置く                      |
| `config/feature-flags.ts`                                  | 配布ページの実験機能フラグ。起動時固定・既定OFF                                             |
| `index.html`／`src`                                        | `@kubohiroya/turbowarp-app-shell`を使う配布ページ                                           |
| `public/downloads`                                         | 配布ページが提供するSB3と`release.json`                                                     |
| `vite.config.ts`                                           | 配布ページのビルド（`base: './'`）                                                          |
| `eslint.config.mjs`／`.prettierrc.json`／`.prettierignore` | lintと書式                                                                                  |
| `tests/`                                                   | ルート側のテスト（vitest）                                                                  |
| `LICENSE`／`package.json`の`license`                       | MPL-2.0                                                                                     |
| `package.json`のscript名                                   | `dev`、`build`、`build:sb3`、`lint`、`format`、`format:write`、`typecheck`、`test`、`check` |
| READMEの構成                                               | 英語を正本とする`README.md`と、相互リンクする`README.ja.md`                                 |

## 意図的に異なるところ

| 相違                                                                                                             | 理由                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/main`ではなく`apps/camera-app`、`apps/fusion-app`、`apps/local-app`の3アプリ                               | 役割の異なる3つのSB3を配布するため。`config/app.json`の各モードが`sb3`でSB3名を持つ                          |
| `scripts/project.ts`ではなく`scripts/app-scripts/`                                                               | 起動確認だけでなく、アプリのblock列全体をTypeScriptから生成するため                                          |
| `scripts/generate-source.ts`ではなくsb3-toolchainと`scripts/build-app-scripts.ts`                                | 展開済みSB3ソースを正本として扱い、生成物を決定的に再生成するため                                            |
| `scripts/build-sb3.ts`ではなく`scripts/build-downloads.ts`                                                       | 各アプリが自分の`dist`へビルドしたSB3を集めて配布ページへ置くため                                            |
| 埋め込み拡張の固定（`config/app-extensions.json`、`pin:extensions`、readiness inventory、bundle member順の検査） | 外部拡張を実際に埋め込んで配布するため。テンプレートは用途固有の拡張依存を持たない                           |
| `release-snapshot`による決定性検証と`apps/<app>/release.json`                                                    | 6 MBの生成物をcommitせずに、ソースidentityとSHA-256で追跡するため                                            |
| `packages/`                                                                                                      | app shell拡張、3Dサービス、ローカルホスト、SB3 script builderをworkspaceとして持つため                       |
| `prettier`の対象外に生成物を追加                                                                                 | `apps/*/source/`、`config/extension-readiness.json`、`apps/*/release.json`は生成スクリプトが書式を決めるため |
| `template:init`を持たない                                                                                        | 本リポジトリはテンプレートではなく、テンプレートから雛形を作る側でもないため                                 |

## 揃え方の方針

- テンプレート側に同じ役割のファイルがあるなら、名前と位置をテンプレートに合わせる。
- テンプレートにない仕組み（拡張の固定、複数アプリ、生成スクリプト）は、テンプレートの構成を
  置き換えずに足す。
- テンプレートが更新されたときは、上の「取り込んだもの」の表にある対象だけを追従の対象とし、
  「意図的に異なるところ」は差分として維持する。
