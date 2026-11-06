//! 日活上报：进程跨天不重启，也要在服务端留下当天那一条记录。
//!
//! 规则只有一条：**本地时间 04:00 是一天的边界，跨过就报一次。**
//!
//! - **先本地判定再打接口**：每个周期只做一次 `Local::now()` 和一次字符串比较，
//!   不跨日连网络客户端都不构造。接口一天至多几次。
//! - **15s 分片而不是「定时到 04:00」**：`Instant` 基于 `mach_absolute_time`
//!   （macOS）/ QPC（Windows），深度睡眠期间不前进，一次性定时器合盖一整夜后
//!   会在唤醒时再睡满一整夜。分片 + 墙钟读才能保证跨日后 ≤15s 补报。
//! - **退避用单调时钟**：墙钟可被用户拨动，往回拨会让退避永不解除，往前拨会
//!   让退避失效而狂打接口。
//! - **不落盘待报队列**：重复上报由服务端 `(device_id, activity_day)` 幂等收敛。
//!
//! 04:00 而不是 00:00：熬夜到凌晨的用户不该被拆成两天。

use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};

use crate::device_registration::{ActivityPayload, DeviceRegistry};

/// 本地判定周期，也是「跨过 04:00 后重新激活窗口」补报的最大延迟。
const TICK: Duration = Duration::from_secs(15);
/// 启动错峰：让日志、目录对账、sidecar spawn 先稳定。
const STARTUP_DELAY: Duration = Duration::from_secs(10);
/// 上报失败后的重试梯度，封顶 15 分钟。
const RETRY_STEPS: [Duration; 5] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(300),
    Duration::from_secs(600),
    Duration::from_secs(900),
];

/// 活跃日 key（`YYYY-MM-DD`），边界是本地时间 04:00。
fn activity_day(now: DateTime<Local>) -> String {
    (now - chrono::Duration::hours(4))
        .format("%Y-%m-%d")
        .to_string()
}

/// 上报状态机：只决定「要不要发」，不碰 IO —— 跨日与退避因此可以单测。
#[derive(Default)]
struct DayState {
    /// 最近一次上报成功的活跃日。
    reported: Option<String>,
    /// 当日失败退避；`day` 一变即失效。
    backoff: Option<Backoff>,
}

struct Backoff {
    day: String,
    failures: usize,
    next_at: Instant,
}

impl DayState {
    fn should_report(&self, day: &str, now: Instant) -> bool {
        if self.reported.as_deref() == Some(day) {
            return false;
        }
        !matches!(
            &self.backoff,
            Some(backoff) if backoff.day == day && now < backoff.next_at
        )
    }

    /// 进程内首次成功上报之前都算 `launch`，之后换日算 `rollover`。
    /// 两个字面量只在这里出现，payload 与日志共用。
    fn trigger(&self) -> &'static str {
        if self.reported.is_none() {
            "launch"
        } else {
            "rollover"
        }
    }

    fn mark_ok(&mut self, day: String) {
        self.reported = Some(day);
        self.backoff = None;
    }

    /// 记一次失败，返回当日累计失败次数（供日志使用）。
    fn mark_failed(&mut self, day: String, now: Instant) -> usize {
        let failures = match &self.backoff {
            Some(backoff) if backoff.day == day => backoff.failures + 1,
            _ => 1,
        };
        self.backoff = Some(Backoff {
            day,
            failures,
            next_at: now + RETRY_STEPS[(failures - 1).min(RETRY_STEPS.len() - 1)],
        });
        failures
    }
}

/// 启动上报循环。`boot.json` 只有一个写者，重复 spawn 会双写并重复上报。
pub(crate) fn spawn(registry: Arc<DeviceRegistry>) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        tauri::async_runtime::spawn(async move { run(registry).await });
    });
}

async fn run(registry: Arc<DeviceRegistry>) {
    tokio::time::sleep(STARTUP_DELAY).await;

    let mut state = DayState::default();
    loop {
        let day = activity_day(Local::now());
        if state.should_report(&day, Instant::now()) {
            let trigger = state.trigger();
            match registry
                .report(Some(ActivityPayload {
                    client_day: day.clone(),
                    trigger,
                }))
                .await
            {
                Ok(()) => {
                    crate::runtime_log::record_event(
                        "info",
                        "activity.report.ok",
                        format!("day={day} trigger={trigger}"),
                    );
                    state.mark_ok(day);
                }
                Err(error) => {
                    let failures = state.mark_failed(day.clone(), Instant::now());
                    crate::runtime_log::record_event(
                        "warn",
                        "activity.report.failed",
                        format!("day={day} trigger={trigger} failures={failures} error={error}"),
                    );
                }
            }
        }
        // 「今天已报过」是常态，一天 5760 次；什么都不做，连 debug 日志都不写。
        tokio::time::sleep(TICK).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn local_at(hour: u32, minute: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 7, hour, minute, 0).unwrap()
    }

    #[test]
    fn day_key_moves_at_local_four_am() {
        assert_eq!(activity_day(local_at(3, 59)), "2026-11-06");
        assert_eq!(activity_day(local_at(4, 0)), "2026-11-07");
        // 跨年后 04:00 之前仍算前一年的最后一天。
        let new_year = Local.with_ymd_and_hms(2027, 1, 1, 2, 0, 0).unwrap();
        assert_eq!(activity_day(new_year), "2026-12-31");
    }

    #[test]
    fn a_reported_day_never_reports_again_but_the_next_one_does() {
        let mut state = DayState::default();
        let now = Instant::now();
        assert!(state.should_report("2026-11-07", now));
        assert_eq!(state.trigger(), "launch");

        state.mark_ok("2026-11-07".into());
        for _ in 0..10 {
            assert!(!state.should_report("2026-11-07", now));
        }
        assert_eq!(state.trigger(), "rollover");
        assert!(state.should_report("2026-11-08", now));
    }

    #[test]
    fn failure_backoff_throttles_same_day_only() {
        let mut state = DayState::default();
        let now = Instant::now();

        assert_eq!(state.mark_failed("2026-11-06".into(), now), 1);
        assert!(!state.should_report("2026-11-06", now));
        assert!(state.should_report("2026-11-06", now + RETRY_STEPS[0]));
        // 失败不影响 trigger：首次成功之前一直算 launch。
        assert_eq!(state.trigger(), "launch");

        // 昨天失败到封顶 15m，换日后也不该被挡住。
        for _ in 0..10 {
            state.mark_failed("2026-11-06".into(), now);
        }
        assert!(state.should_report("2026-11-07", now));

        // 成功会清掉退避，下一次换日立刻可报。
        state.mark_ok("2026-11-07".into());
        assert!(state.backoff.is_none());
        assert!(state.should_report("2026-11-08", now));
    }

    #[test]
    fn retry_steps_are_monotonic_and_capped() {
        assert!(RETRY_STEPS.windows(2).all(|pair| pair[0] < pair[1]));
        let mut state = DayState::default();
        let now = Instant::now();
        for _ in 0..20 {
            state.mark_failed("2026-11-07".into(), now);
        }
        let backoff = state.backoff.unwrap();
        assert_eq!(backoff.failures, 20);
        assert_eq!(backoff.next_at, now + RETRY_STEPS[RETRY_STEPS.len() - 1]);
    }
}
