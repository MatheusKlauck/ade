use crate::error::AdeError;
use std::time::Instant;
use tokio::sync::Mutex;

/// Per-process rate-limit budget. Shared across all workspace workers.
/// When a 403/429 is received, `pause_until` is set; all workers skip
/// cycles until the pause expires.
pub struct RateBudget {
    paused_until: Mutex<Option<Instant>>,
}

impl RateBudget {
    pub fn new() -> Self {
        Self {
            paused_until: Mutex::new(None),
        }
    }

    /// Returns Ok(()) if not paused, Err(RateLimited) if paused.
    /// Callers should check before making HTTP requests.
    pub async fn check(&self) -> Result<(), AdeError> {
        let guard = self.paused_until.lock().await;
        if let Some(until) = *guard {
            if Instant::now() < until {
                let remaining = until - Instant::now();
                return Err(AdeError::RateLimited(format!("{:?}", remaining)));
            }
        }
        Ok(())
    }

    /// Set paused_until from a rate limit response.
    pub async fn pause_until(&self, until: Instant) {
        *self.paused_until.lock().await = Some(until);
    }

    /// Clear the pause (e.g., after a successful request).
    #[allow(dead_code)]
    pub async fn clear(&self) {
        *self.paused_until.lock().await = None;
    }
}
