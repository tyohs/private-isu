-- Roll back only the index introduced by the matching up migration.
ALTER TABLE `posts`
  DROP INDEX `idx_posts_user_id_created_at`,
  ALGORITHM=INPLACE, LOCK=NONE;
