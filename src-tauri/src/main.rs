// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use base64::Engine;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

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

// ----- Attachments (images and files placed on the canvas) -----
// Stored as <data folder>/attachments/<id>, where id is "<uuid>.<ext>".

fn attachments_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create attachments folder: {e}"))?;
    Ok(dir)
}

/// Only allow simple names like "3f2a…-…9c.png" so nothing can escape the folder.
fn attachment_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let ok = !id.is_empty()
        && id.len() <= 120
        && !id.starts_with('.')
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    if !ok {
        return Err(format!("invalid attachment id: {id}"));
    }
    Ok(attachments_dir(app)?.join(id))
}

/// Save an attachment. `data` is base64 (whitespace is ignored).
#[tauri::command]
fn save_attachment(app: tauri::AppHandle, id: String, data: String) -> Result<(), String> {
    let path = attachment_path(&app, &id)?;
    let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean)
        .map_err(|e| format!("bad attachment data: {e}"))?;
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| format!("could not save attachment: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not save attachment: {e}"))
}

/// Read an attachment as base64, or None if it isn't on this computer (yet).
#[tauri::command]
fn read_attachment(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let path = attachment_path(&app, &id)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read attachment: {e}")),
    }
}

/// Ids of all attachments stored on this computer.
#[tauri::command]
fn list_attachments(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = attachments_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".part") {
                out.push(name);
            }
        }
    }
    Ok(out)
}

/// Open an attachment in the computer's default app for that file type.
#[tauri::command]
fn open_attachment(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = attachment_path(&app, &id)?;
    if !path.exists() {
        return Err("This file hasn't been downloaded to this computer yet.".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
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
            secret_delete,
            save_attachment,
            read_attachment,
            list_attachments,
            open_attachment
        ])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
