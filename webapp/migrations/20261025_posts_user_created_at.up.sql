-- Opt-in tuning for the local practice database. Run outside a benchmark.
ALTER TABLE `posts`
  ADD INDEX `idx_posts_user_id_created_at` (`user_id`, `created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;
