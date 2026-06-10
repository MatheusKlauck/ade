use tauri::Emitter;

pub fn emit_notify(app: &tauri::AppHandle, level: &str, code: &str, message: &str) {
    let _ = app.emit(
        "evt:notify",
        serde_json::json!({
            "level": level,
            "code": code,
            "message": message,
        }),
    );
}
