# ローカル練習の計測コマンド

チームの [PR #2](https://github.com/ue-sho/private-isu-2026/pull/2) を参考に、Mac向けのTaskfileを用意した。

## ツール

```sh
brew install alp go-task percona-toolkit
```

`task` は `Taskfile.yml` に名前を付けて登録したコマンドを実行するツール。
`alp` はnginxのアクセスログをURLごとに集計し、`pt-query-digest` はMySQLログをSQLの形ごとに集計する。

## 操作

```sh
cd /Users/yk/Documents/private/isu-con/private-isu
task --list
task check
task analyze
```

`task analyze` の結果は `log/nginx/alp_日時.txt` と `log/mysql/digest_日時.txt` に保存され、画面にも表示される。
既存ログ全体を対象にするため、過去の計測が混ざっている場合は1回のベンチ結果として扱わない。
現在の `task analyze` は解析後に元ログを移動し、nginxのreopen、MySQLのflush-logs、権限変更も行う。
Taskfileの「元ログは保持」という説明だけで読み取り専用と判断しない。ログを動かさず解析する場合は次を使う。

```sh
alp ltsv --sort sum -r --nosave-pos \
  --matching-groups='/posts/[0-9]+,/image/[0-9]+,/@[A-Za-z0-9_]+' \
  --file webapp/etc/nginx/log/access.log
pt-query-digest --limit 5 webapp/etc/mysql/log/slow.log
```

これは既存ログ全体の集計であり、単一試行の結果とは限らない。
PRの `-r json` はLTSV解析には不要な引数なので、降順を指定する `-r` のみとした。
数値IDの異なる投稿・画像・ユーザーページは、URLの形ごとにまとめて集計する。

nginxの `COUNT` はアクセス数、`SUM` は処理時間の合計、`AVG` は平均時間（秒）。
MySQLの `Response time` はSQLの累積実行時間、`Calls` は実行回数。
SQLの時間割合はHTTP全体の時間割合ではない。

ローカル練習環境のベンチを実行する場合:

```sh
task bench
```

このタスクは対象アプリの初期化を伴う。共有・本番環境にはそのまま使わない。
今回の下地整備ではベンチは実行していない。
対話的なDB接続は `task connect-mysql`。ローカルComposeに設定したパスワードを入力する。

ログ本体と解析結果はGitの追跡対象から除外している。

## 自律改善の実験記録

[2026年10月25日の実験とISUCON15の準備材料](autonomous-practice-20261025.md) に、再開地点、変更コミット、検証結果、記事から得た知見、ベンチ自動化とAGENTS.md・Skillsの検討材料をまとめた。
