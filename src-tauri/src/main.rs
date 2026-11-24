// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
struct SystemInfo {
    os: String,
    arch: String,
    exe_path: String,
    data_dir: String,
}

#[tauri::command]
fn system_info(app: tauri::AppHandle) -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        exe_path: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|e| format!("unknown ({e})")),
        data_dir: app
            .path()
            .app_data_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|e| format!("unknown ({e})")),
    }
}

/// Write a file into the per-user app data folder and read it back.
#[tauri::command]
fn storage_test(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create folder failed: {e}"))?;
    let file = dir.join("phase0-test.json");
    let body = format!("{{\"written\":\"phase0\",\"pid\":{}}}", std::process::id());
    std::fs::write(&file, &body).map_err(|e| format!("write failed: {e}"))?;
    let back = std::fs::read_to_string(&file).map_err(|e| format!("read failed: {e}"))?;
    if back != body {
        return Err("read-back did not match what was written".into());
    }
    Ok(format!("wrote and read {}", file.display()))
}

/// Store, read and delete a dummy secret in the OS keychain
/// (macOS Keychain / Windows Credential Manager).
#[tauri::command]
fn keychain_test() -> Result<String, String> {
    let entry = keyring::Entry::new("canvas-planner-phase0", "test-user")
        .map_err(|e| format!("open failed: {e}"))?;
    entry
        .set_password("dummy-secret-123")
        .map_err(|e| format!("save failed: {e}"))?;
    let back = entry.get_password().map_err(|e| format!("read failed: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("delete failed: {e}"))?;
    if back != "dummy-secret-123" {
        return Err("read-back did not match".into());
    }
    Ok("saved, read back and deleted a dummy secret".into())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![system_info, storage_test, keychain_test])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
