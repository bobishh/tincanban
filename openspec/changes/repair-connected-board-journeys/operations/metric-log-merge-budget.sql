-- Reversible tuning for the 2 GiB ClickHouse accessory; preserve rows and collection.
-- Sources: ClickHouse v26.8.11.7-lts MergeTask.cpp::chooseMergeAlgorithm and
-- MergeTreeSettings.cpp. Wide metric parts below 131072 rows otherwise use the
-- horizontal pipeline across thousands of columns. Use vertical merging for
-- every eligible Wide result, retaining the default 10 MiB Wide threshold.
-- This existing table already has 310 KiB metadata. ClickHouse 26.8 SystemLog.cpp
-- documents unlimited startup metadata parsing; allow 512 KiB only for this
-- operator connection, without changing global/user query-size defaults.
SET max_query_size = 524288;
ALTER TABLE system.metric_log MODIFY SETTING
    vertical_merge_algorithm_min_rows_to_activate = 0;
-- Remove earlier ineffective trials; restore their upstream defaults.
ALTER TABLE system.metric_log RESET SETTING
    merge_max_block_size, min_bytes_for_wide_part,
    vertical_merge_algorithm_min_bytes_to_activate, max_parts_to_merge_at_once;
-- Rollback (same connection budget):
-- ALTER TABLE system.metric_log RESET SETTING vertical_merge_algorithm_min_rows_to_activate;
