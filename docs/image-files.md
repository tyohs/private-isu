# Node.jsの画像をnginxから配信する

DBの `posts.imgdata` は残し、画像取得時のDB問い合わせ・転送を減らす。
共有するホストの `webapp/public/image/` は、Node.jsでは `/home/public/image/`、nginxでは `/public/image/` に見える。
生成画像はGit対象外。

## 動作

- `/image/123.jpg` のファイルがあればnginxが直接返す。なければNode.jsへ渡す。
- Node.jsは従来どおりIDとMIMEを確認し、DBの画像を返す前にファイルも保存する。次の取得からはnginxが返す。
- 新規投稿は従来のDB保存に続けてファイル保存する。保存失敗時もDBから取得できる。
- 一時ファイルを同じディレクトリに書き、renameしてから公開する。
- `/initialize` は従来のDB初期化に加え、IDが10000を超える生成画像を削除する。初期画像は保持する。
- ID 0、先頭に0が付くID、MIMEと一致しない拡張子、存在しないIDはアプリ側の処理を維持する。

## ローカルComposeへの反映

実行対象はこのチェックアウトのローカル練習環境。DBの再インポートや初期化は不要。

```sh
cd /Users/yk/Documents/private/isu-con/private-isu/webapp
docker compose build app
docker compose up -d --no-deps app
docker compose exec -T app npm run export-images
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
```

`export-images` は既存画像をID順に10件ずつDBから読み出して保存する。再実行可能。
実行中に投稿・初期化や別の書き出し処理を並行させないこと。
書き出しを省略しても、画像を最初に取得するとファイルが作られる。
アプリの再作成後はnginxをreloadして、新しいアプリの接続先を反映する。

## 他言語へ切り替える場合

Ruby・Go・PHP・PythonはDBの画像を引き続き読み書きできるが、生成画像の保存・削除処理を持たない。
特に他言語の初期化後に追加投稿のファイルが残ると、削除済みの画像を返す可能性がある。
他言語へ切り替える際は、`default.conf` の画像用 `location` と `@image_app` を外してnginxをreloadする。
本変更では他言語のコードやDBスキーマ、ベンチマーカーは変更していない。

## 確認

```sh
cd /Users/yk/Documents/private/isu-con/private-isu/webapp/node
npm test
```

バイナリの一致、保存中の読み取り、失敗時の一時ファイル削除、初期化の削除範囲、バッチ書き出しを確認する。
実環境では画像のバイナリ・Content-Type・404・ID 0の応答を確認し、静的配信時のnginxログは `apptime:-` になることを確認する。
性能比較は同じ条件のベンチで行う。ベンチはDB初期化を伴うため、実行の許可を別途確認する。

## 2026-10-10の確認結果

- ローカルComposeのNode.jsを再ビルド・再作成し、nginxをreloadして反映した。MySQL・Memcachedは再起動していない。
- ホストとNode.jsコンテナの両方でビルドと5テストが成功した。nginxの設定検証も成功した。
- 既存画像10,055件を書き出した。画像のDBデータは変更していない。
- JPG・PNG・GIFで、初回のDB応答・生成ファイル・次回の静的HTTP応答のバイナリとMIMEが一致した。
- nginxログの初回は `apptime` に数値、2回目は `apptime:-`。画像取得時のSet-Cookieもない。
- 拡張子不一致と存在しないIDは404、ID 0は空の200、先頭0付きのIDも従来どおり取得できた。
- 練習用の既存アカウントでPNGを1件投稿（ID 10757）。画像GETより前にファイルが存在し、DBとHTTP応答も一致した。この確認用投稿は残している。
- 実DBの初期化・標準ベンチは実行していない。初期化のファイル削除範囲は一時ディレクトリのテストで確認した。スコア改善は未計測。
- 検証のスクリプトと結果はGit対象外の `log/image-files/` に保存した。
