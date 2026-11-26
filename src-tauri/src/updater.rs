use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::async_runtime::Mutex;
use tauri_plugin_http::reqwest::{Client, Response};
use tempfile::{Builder, TempDir};

const RELEASE_API: &str = "https://api.github.com/repos/7ordansb/canvas-planner/releases";
const STAGE_PREFIX: &str = ".canvas-planner-update-";
const APPLY_ARG: &str = "--apply-prepared-update";
const CLEANUP_ARG: &str = "--cleanup-applied-update";
const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[cfg(target_os = "macos")]
const ASSET: &str = "CanvasPlanner-mac.zip";
#[cfg(target_os = "macos")]
const REPLACEMENT: &str = "Canvas Planner.app";
#[cfg(windows)]
const ASSET: &str = "CanvasPlanner.exe";
#[cfg(windows)]
const REPLACEMENT: &str = ASSET;
#[cfg(not(any(windows, target_os = "macos")))]
const ASSET: &str = "";
#[cfg(not(any(windows, target_os = "macos")))]
const REPLACEMENT: &str = "";

#[derive(Default)]
pub struct State {
    update: Mutex<Update>,
    result_consumed: AtomicBool,
}

#[derive(Default)]
struct Update {
    prepared: Option<(TempDir, PathBuf)>,
    // The helper waits for this pipe to close before touching the application.
    shutdown: Option<ChildStdin>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
    state: String,
    size: u64,
    digest: Option<String>,
}

async fn get(client: &Client, path: &str, accept: &str) -> Result<Response, String> {
    client
        .get(format!("{RELEASE_API}/{path}"))
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| error(e.without_url()))?
        .error_for_status()
        .map_err(|e| error(e.without_url()))
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn app_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(error)?;
    #[cfg(target_os = "macos")]
    let path = executable
        .ancestors()
        .find(|path| path.extension() == Some(OsStr::new("app")))
        .map(Path::to_path_buf)
        .ok_or("Move Canvas Planner.app into Applications and open it there to update.")?;
    #[cfg(not(target_os = "macos"))]
    let path = executable;
    Ok(path)
}

#[tauri::command]
pub async fn prepare_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<Option<String>, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("In-app updates support Windows and macOS.".into());
    }
    let mut update = state
        .update
        .try_lock()
        .map_err(|_| "An update is already running.")?;
    if update.shutdown.is_some() {
        return Err("An update is already restarting the app.".into());
    }
    update.prepared = None;
    let client = Client::builder()
        .user_agent("Canvas-Planner-Updater")
        .https_only(true)
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(error)?;
    let metadata = get(&client, "latest", "application/vnd.github+json")
        .await?
        .bytes()
        .await
        .map_err(error)?;
    let release: Release = serde_json::from_slice(&metadata).map_err(error)?;
    let version = Version::parse(release.tag_name.trim_start_matches('v')).map_err(error)?;
    if release.draft
        || release.prerelease
        || !version.pre.is_empty()
        || version <= app.package_info().version
    {
        return Ok(None);
    }
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == ASSET && asset.state == "uploaded")
        .ok_or("The latest release doesn't have a download for this platform yet.")?;
    let digest = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("GitHub hasn't provided a checksum for this download.")?;
    if asset.size == 0 || asset.size > MAX_BYTES {
        return Err("The update download size is invalid.".into());
    }
    let path = app_path()?;
    let parent = path
        .parent()
        .ok_or("Couldn't find the application folder.")?;
    let stage = Builder::new()
        .prefix(STAGE_PREFIX)
        .tempdir_in(parent)
        .map_err(|e| {
            format!(
                "Couldn't write beside the app. Move it to a writable folder and try again. ({e})"
            )
        })?;
    let download = stage.path().join(ASSET);
    let mut file = fs::File::create(&download).map_err(error)?;
    let mut response = get(
        &client,
        &format!("assets/{}", asset.id),
        "application/octet-stream",
    )
    .await?;
    let mut hash = Sha256::new();
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(error)? {
        size += chunk.len() as u64;
        if size > asset.size {
            return Err("The update download is larger than GitHub reported.".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(error)?;
    }
    let actual: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if size != asset.size || !actual.eq_ignore_ascii_case(digest) {
        return Err("The downloaded update didn't match the checksum from GitHub.".into());
    }
    file.sync_all().map_err(error)?;
    drop(file);
    unpack(stage.path(), &download, &version)?;
    update.prepared = Some((stage, path));
    Ok(Some(version.to_string()))
}

#[cfg(target_os = "macos")]
fn unpack(stage: &Path, download: &Path, version: &Version) -> Result<(), String> {
    let status = Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(download)
        .arg(stage)
        .status()
        .map_err(error)?;
    if !status.success() {
        return Err("Couldn't unpack the Mac update.".into());
    }
    let bundle = stage.join(REPLACEMENT);
    let plist = bundle.join("Contents/Info.plist");
    let version = version.to_string();
    for (property, expected) in [
        ("CFBundleIdentifier", "com.canvasplanner.desktop"),
        ("CFBundleShortVersionString", version.as_str()),
    ] {
        let output = Command::new("/usr/bin/plutil")
            .args(["-extract", property, "raw", "-o", "-"])
            .arg(&plist)
            .output()
            .map_err(error)?;
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != expected {
            return Err("The downloaded Mac app doesn't match the release.".into());
        }
    }
    let status = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(&bundle)
        .status()
        .map_err(error)?;
    if !status.success() {
        return Err("macOS couldn't verify the downloaded app bundle.".into());
    }
    fs::remove_file(download).map_err(error)
}

#[cfg(not(target_os = "macos"))]
fn unpack(_: &Path, _: &Path, _: &Version) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn apply_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<(), String> {
    let mut update = state
        .update
        .try_lock()
        .map_err(|_| "An update is already running.")?;
    let (stage, path) = update.prepared.take().ok_or("Check for an update first.")?;
    let target = path
        .file_name()
        .ok_or("Couldn't find the application name.")?;
    let executable = std::env::current_exe().map_err(error)?;
    let helper = stage.path().join(if cfg!(windows) {
        "update-helper.exe"
    } else {
        "update-helper"
    });
    fs::copy(executable, &helper).map_err(error)?;
    let lock_path = crate::data_dir(&app)?.join("app-update.lock");
    let mut child = Command::new(&helper)
        .arg(APPLY_ARG)
        .arg(target)
        .arg(lock_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(error)?;
    update.shutdown = child.stdin.take();
    let _ = stage.keep();
    drop(update);
    app.exit(0);
    Ok(())
}

fn is_file_name(name: &OsStr) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(part)) if part == name)
        && components.next().is_none()
}

pub fn run_helper() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(APPLY_ARG)) {
        return false;
    }
    if let Err(message) = finish_update(args.next(), args.next()) {
        eprintln!("Couldn't apply update: {message}");
        std::process::exit(1);
    }
    true
}

fn finish_update(target: Option<OsString>, lock_path: Option<OsString>) -> Result<(), String> {
    let target = target
        .filter(|name| is_file_name(name))
        .ok_or("Invalid application name.")?;
    let helper = std::env::current_exe().map_err(error)?;
    let stage = helper.parent().ok_or("Missing update folder.")?;
    let stage_name = stage
        .file_name()
        .filter(|name| name.to_string_lossy().starts_with(STAGE_PREFIX))
        .ok_or("Invalid update folder.")?;
    let destination = stage
        .parent()
        .ok_or("Missing application folder.")?
        .join(target);
    let backup = stage.join("previous");
    let replacement = stage.join(REPLACEMENT);
    if !destination.exists() || !replacement.exists() {
        return Err("The current app or its replacement is missing.".into());
    }

    // EOF indicates shutdown. Windows may still be releasing the executable handle.
    std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink()).map_err(error)?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path.ok_or("Missing update lock.")?)
        .map_err(error)?;
    lock.lock().map_err(error)?;
    #[cfg(target_os = "macos")]
    let installed_executable = destination.join("Contents/MacOS/canvas-planner");
    #[cfg(not(target_os = "macos"))]
    let installed_executable = &destination;
    if fs::read(installed_executable).map_err(error)? != fs::read(&helper).map_err(error)? {
        fs::write(
            stage.join("error.txt"),
            "The app changed while this update was being prepared.",
        )
        .map_err(error)?;
        return launch(&destination, stage_name);
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let result = loop {
        match fs::rename(&destination, &backup) {
            Ok(()) => break fs::rename(&replacement, &destination).map_err(error),
            Err(e) if Instant::now() >= deadline => break Err(error(e)),
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    };
    let result = result.and_then(|()| launch(&destination, stage_name));
    if let Err(e) = result {
        if backup.exists() {
            if destination.exists() {
                fs::rename(&destination, &replacement).map_err(error)?;
            }
            fs::rename(&backup, &destination).map_err(error)?;
        }
        let _ = fs::write(
            stage.join("error.txt"),
            format!("The update couldn't be applied. {e}"),
        );
        launch(&destination, stage_name)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch(destination: &Path, stage_name: &OsStr) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg("-n")
        .arg(destination)
        .args(["--args", CLEANUP_ARG])
        .arg(stage_name)
        .status()
        .map_err(error)?;
    if status.success() {
        Ok(())
    } else {
        Err("macOS couldn't reopen Canvas Planner.".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn launch(destination: &Path, stage_name: &OsStr) -> Result<(), String> {
    Command::new(destination)
        .arg(CLEANUP_ARG)
        .arg(stage_name)
        .current_dir(destination.parent().ok_or("Missing application folder.")?)
        .spawn()
        .map(|_| ())
        .map_err(error)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum UpdateResult {
    Installed { version: String },
    Failed { message: String },
}

#[tauri::command]
pub fn update_result(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Option<UpdateResult> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(CLEANUP_ARG)) {
        return None;
    }
    let stage_name = args
        .next()
        .filter(|name| is_file_name(name) && name.to_string_lossy().starts_with(STAGE_PREFIX))?;
    let stage = app_path().ok()?.parent()?.join(stage_name);
    if !stage.is_dir() || state.result_consumed.swap(true, Ordering::Relaxed) {
        return None;
    }
    let result = match fs::read_to_string(stage.join("error.txt")) {
        Ok(message) => UpdateResult::Failed { message },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => UpdateResult::Installed {
            version: app.package_info().version.to_string(),
        },
        Err(e) => UpdateResult::Failed {
            message: format!("Couldn't read the update result. {e}"),
        },
    };
    // On Windows the helper itself may still be locked until it exits.
    std::thread::spawn(move || {
        for _ in 0..20 {
            if fs::remove_dir_all(&stage).is_ok() || !stage.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    Some(result)
}
