# デモ用アバター

`demo-humanoid.vrm`は、fusion appがVRMを指定されていないときに表示するアバターです。
[`turbowarp-aframe`](https://github.com/kubohiroya/turbowarp-aframe)の
`scripts/generate-test-vrm.ts`（0.5.0、`ec1bb3c`）が書き出したもので、第三者のモデルやライセンスを
含みません。

- VRM 1.0。必須のヒューマノイドのボーンを持ち、各ボーンを箱で描いた人型です。
- 表情はプリセットの`happy`（頭を横に広げる）と、カスタムの`glow`（頭の色を変える）です。

`scripts/app-scripts/avatar.ts`がビルド時にこのファイルをdata URLにしてSB3へ埋め込むため、
ネットワークにもファイルにも頼らずに表示できます。作り直すときは`turbowarp-aframe`で次を実行します。

```bash
node scripts/generate-test-vrm.ts <このディレクトリ>/demo-humanoid.vrm
```
