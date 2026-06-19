//! 时间助手 — 列表过滤 (thisWeek / thisMonth) 用的 epoch 毫秒边界。
//!
//! 时间戳在 memo 元数据里以 `chrono::Utc::now().timestamp_millis()` 写入,
//! 读回时也用同一时钟, 避免本地时区漂移。

use chrono::Datelike;

/// 当前 UTC 时间的 epoch 毫秒。
pub fn chrono_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 本 ISO 周起点 (周一 00:00 UTC) 的 epoch 毫秒。
pub fn start_of_this_week(now_ms: i64) -> i64 {
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(chrono::Utc::now);
    let date = now.date_naive();
    let weekday = date.weekday();
    let days_from_monday = weekday.num_days_from_monday() as i64;
    let monday = date - chrono::Duration::days(days_from_monday);
    let monday_midnight = monday
        .and_hms_opt(0, 0, 0)
        .unwrap_or_else(|| date.and_hms_opt(0, 0, 0).unwrap());
    monday_midnight.and_utc().timestamp_millis()
}

/// 当前日历月起点 (1 号 00:00 UTC) 的 epoch 毫秒。
///
/// `thisMonth` 故意走 `month_start` 而非 `week_start`, 这样本月早些时候的 memo
/// 也能命中; 因为 `month_start <= week_start`, `thisWeek` 范围是 `thisMonth` 的子集。
pub fn start_of_this_month(now_ms: i64) -> i64 {
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(chrono::Utc::now);
    let first = now
        .date_naive()
        .with_day(1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .unwrap_or_else(|| now.date_naive().and_hms_opt(0, 0, 0).unwrap());
    first.and_utc().timestamp_millis()
}
