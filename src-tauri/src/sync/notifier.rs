/// Trait for emitting notifications. In production, this wraps `app.emit`.
/// In tests, it appends to a Vec for assertion.
pub trait Notifier: Send + Sync {
    fn notify(&self, level: &str, code: &str, message: &str);
}

/// A no-op notifier that discards all notifications.
#[allow(dead_code)]
pub struct NoopNotifier;

impl Notifier for NoopNotifier {
    fn notify(&self, _level: &str, _code: &str, _message: &str) {}
}

/// A notifier that captures (level, code, message) triples for test assertion.
#[allow(dead_code)]
pub struct CaptureNotifier {
    events: std::sync::Mutex<Vec<(String, String, String)>>,
}

#[allow(dead_code)]
impl CaptureNotifier {
    pub fn new() -> Self {
        Self {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn take(&self) -> Vec<(String, String, String)> {
        self.events.lock().expect("lock").drain(..).collect()
    }
}

impl Notifier for CaptureNotifier {
    fn notify(&self, level: &str, code: &str, message: &str) {
        self.events.lock().expect("lock").push((
            level.to_string(),
            code.to_string(),
            message.to_string(),
        ));
    }
}

/// A Notifier that wraps a `tauri::AppHandle` and emits via `app.emit`.
pub struct AppNotifier(pub tauri::AppHandle);

impl Notifier for AppNotifier {
    fn notify(&self, level: &str, code: &str, message: &str) {
        crate::notify::emit_notify(&self.0, level, code, message);
    }
}
