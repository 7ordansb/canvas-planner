// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const KEYCHAIN_SERVICE: &str = "canvas-planner";

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create data folder: {e}"))?;
    Ok(dir)
}

/// Read the board file (or its backup). Returns None if it doesn't exist yet.
#[tauri::command]
fn load_board(app: tauri::AppHandle, backup: bool) -> Result<Option<String>, String> {
    let file = data_dir(&app)?.join(if backup { "board.backup.json" } else { "board.json" });
    match std::fs::read_to_string(&file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", file.display())),
    }
}

/// Save the board safely: validate, keep a backup of the previous good file,
/// write to a temp file, then swap it into place.
#[tauri::command]
fn save_board(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("refusing to save invalid data: {e}"))?;
    let dir = data_dir(&app)?;
    let main = dir.join("board.json");
    if let Ok(old) = std::fs::read_to_string(&main) {
        if serde_json::from_str::<serde_json::Value>(&old).is_ok() {
            let _ = std::fs::write(dir.join("board.backup.json"), old);
        } else {
            let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = std::fs::rename(&main, dir.join(format!("board.unreadable-{ts}.json")));
        }
    }
    let tmp = dir.join("board.json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &main).map_err(|e| format!("could not replace board file: {e}"))?;
    Ok(())
}

/// Where the board is stored (shown in Settings).
#[tauri::command]
fn data_folder(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.display().to_string())
}

// ----- Secrets in the OS keychain (macOS Keychain / Windows Credential Manager) -----

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_board,
            save_board,
            data_folder,
            secret_get,
            secret_set,
            secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
