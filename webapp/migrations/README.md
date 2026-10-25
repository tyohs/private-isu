# ローカル練習用の索引変更

初期問題や既存ボリュームへ自動適用しない、明示実行用のSQL。アプリの起動や `/initialize` は索引を作成・削除しない。以下は `private-isu` リポジトリ直下から、ローカルComposeへ実行する。

`20261025_posts_user_created_at` は `posts(user_id, created_at)` の非一意索引を追加する。プロフィールの投稿者検索・日時順・投稿数・被コメント数の集計を対象とし、user_id単独の索引を別途追加する必要はない。既存の `idx_posts_created_at` はトップ・一覧のために保持する。データ・カラム・一意性の制約は変更しない。

ベンチ・他のDDLと同時に実行しない。事前に `SHOW INDEX FROM posts` で状態を確認する。同じup/downを再実行すると既存/不存在エラーで停止する。既存索引を無条件に削除する処理は含めない。

```sh
# 状態確認。認証情報は既存コンテナの環境変数を使い、コマンド引数へ出さない。
docker compose -f webapp/compose.yml exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot isuconp -e "SHOW INDEX FROM posts"'

# 追加。メタデータロックは10秒でタイムアウトさせる。
docker compose -f webapp/compose.yml exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --init-command="SET SESSION lock_wait_timeout = 10" isuconp' \
  < webapp/migrations/20261025_posts_user_created_at.up.sql
```

追加後は状態確認、実行計画、HTTPの正しさ、標準ベンチを順に確認する。全言語が同じテーブルを使うため、特にトップ・一覧のJOIN順が変わっていないかも見る。今回のNode版では、ユーザー側から全投稿を集める退行を実測したため、トップと `/posts` を同じコミットで `STRAIGHT_JOIN` に変更し、投稿側から取得する。索引SQLだけを旧アプリへ適用する構成は採用しない。他言語は実行検証していない。`INPLACE, LOCK=NONE` でも開始・終了時のメタデータロックは必要で、書き込み時の索引更新コストは増える。

戻す場合もベンチ終了後に実行する。

```sh
docker compose -f webapp/compose.yml exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --init-command="SET SESSION lock_wait_timeout = 10" isuconp' \
  < webapp/migrations/20261025_posts_user_created_at.down.sql
```

Gitやアプリイメージを戻してもDBの索引は戻らない。ベンチの結果にはコミットIDと実DBの索引定義を両方記録する。検証結果は [実験記録](../../docs/autonomous-practice-20261025.md) の「続編2」に残す。
