# NOISE

Safariで動作する2人対戦オンラインカードゲームです。Node.jsだけでHTTP配信とWebSocket同期を行い、勝敗判定とノイズ処理はサーバー側で実行します。

## ローカル起動

```bash
npm start
```

ブラウザで `http://localhost:3000` を開きます。

## Render Freeで公開

このリポジトリにはRender用の `render.yaml` を含めています。

1. GitHubにこのフォルダをリポジトリとしてpushします。
2. Renderで `New` -> `Blueprint` を選びます。
3. GitHubリポジトリを接続します。
4. `render.yaml` が読み込まれたら `Apply` します。
5. デプロイ完了後に発行される `https://...onrender.com` が公開URLです。

手動で `Web Service` として作る場合は以下です。

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Instance Type: `Free`

## 無料公開時の注意

- Render Freeは一定時間アクセスがないとスリープします。
- スリープや再起動が起きると、メモリ上のルームは消えます。
- 小規模なテスト公開には十分ですが、常設運用ではRedisやDBにルーム状態を保存する構成が必要です。

## 実装メモ

- ルームコード方式で2人が入室すると自動開始します。
- 端末ごとのセッションIDを `localStorage` に保存し、同じルームへ再接続できます。
- 数字選択、ノイズ選択、効果解決、得点加算はサーバー権威です。
- 1ラウンド目に `CHAIN` が出た場合はサーバーが引き直します。
- `Echo` は相手の過去のノイズ履歴から直近の非 `Echo` カードをコピーします。コピー効果は `Echo` ステップで解決されます。
