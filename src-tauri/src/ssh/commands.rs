//! Tauri commands exposed to the frontend. Every function returns `Result<T, String>`
//! with Chinese error messages that match the contract §6 verbatim.
//!
//! Argument naming: Tauri maps each Rust parameter to one JS object key, so the
//! frontend calls `invoke("ssh_connect", { profileId, password, passphrase })`.
//! Never wrap arguments in a single struct — that would make the wire format
//! `{ args: { ... } }` and every frontend call would fail.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, State};

use super::config::SshProfile;
use super::files::{self, OpenedFile, RemoteDirList, RemoteStat, RenameResult, WriteResult};
use super::forward::{ForwardInfo, ForwardSpec};
use super::session::{self, SshSessionInfo};
use super::SshHub;

/// `{ transferId }` as the frontend expects it.
type TransferId = serde_json::Value;

fn err_not_found() -> String {
    "SSH 配置不存在。".into()
}

fn err_not_connected() -> String {
    "SSH 会话未连接。".into()
}

/// Clone a session handle out of the hub. Returns an owned Arc<SessionHandle>.
fn get_session(hub: &SshHub, profile_id: &str) -> Result<Arc<session::SessionHandle>, String> {
    let entry = hub.sessions.get(profile_id).ok_or_else(err_not_connected)?;
    let handle: session::SessionHandle = entry.value().clone();
    Ok(Arc::new(handle))
}

async fn with_session<F, Fut, T>(handle: Arc<session::SessionHandle>, op: F) -> Result<T, String>
where
    F: FnOnce(Arc<session::SessionHandle>) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    op(handle).await
}

/// Run an async SSH operation on the hub's dedicated runtime. The future must be
/// `'static` (own all data it needs) because `spawn_blocking` requires it.
async fn run<T, F>(runtime: Arc<tokio::runtime::Runtime>, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, String>> + Send + 'static,
{
    tokio::task::spawn_blocking(move || runtime.block_on(task))
        .await
        .map_err(|error| format!("SSH 操作失败：{error}"))?
}

// ───────────────────────────── Profiles ─────────────────────────────

#[tauri::command]
pub async fn ssh_profile_list(
    hub: State<'_, SshHub>,
) -> Result<Vec<super::config::SshProfileInfo>, String> {
    let secrets = super::secrets_bridge();
    let profiles = hub.profiles.list();
    let mut infos = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let has_password = secrets.has_password(&profile.id)?;
        let has_passphrase = secrets.has_passphrase(&profile.id)?;
        infos.push(super::config::SshProfileInfo {
            profile,
            has_password,
            has_passphrase,
        });
    }
    Ok(infos)
}

#[tauri::command]
pub async fn ssh_profile_save(
    hub: State<'_, SshHub>,
    profile: SshProfile,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<super::config::SshProfileInfo, String> {
    let secrets = super::secrets_bridge();
    let saved = hub.profiles.save(profile)?;
    if saved.remember_secret {
        if let Some(password) = password.as_deref().filter(|value| !value.is_empty()) {
            secrets.set_password(&saved.id, password)?;
        }
        if let Some(passphrase) = passphrase.as_deref().filter(|value| !value.is_empty()) {
            secrets.set_passphrase(&saved.id, passphrase)?;
        }
    } else {
        secrets.delete(&saved.id)?;
    }
    let has_password = secrets.has_password(&saved.id)?;
    let has_passphrase = secrets.has_passphrase(&saved.id)?;
    Ok(super::config::SshProfileInfo {
        profile: saved,
        has_password,
        has_passphrase,
    })
}

#[tauri::command]
pub async fn ssh_profile_delete(hub: State<'_, SshHub>, id: String) -> Result<(), String> {
    if hub.sessions.contains_key(&id) {
        if let Some((_, handle)) = hub.sessions.remove(&id) {
            handle
                .closed
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let guard = handle.inner.lock().await;
            let _ = guard
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            hub.forwards.stop_all(&id);
        }
    }
    let secrets = super::secrets_bridge();
    secrets.delete(&id)?;
    hub.profiles.delete(&id)
}

// ───────────────────────────── Sessions ─────────────────────────────

#[tauri::command]
pub async fn ssh_connect(
    hub: State<'_, SshHub>,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<SshSessionInfo, String> {
    let profile = hub.profiles.get(&profile_id).ok_or_else(err_not_found)?;
    let secrets = super::secrets_bridge();

    let password = password.filter(|value| !value.is_empty()).or_else(|| {
        if matches!(profile.auth, super::config::SshAuth::Password) {
            secrets.get_password(&profile.id).ok().flatten()
        } else {
            None
        }
    });
    let passphrase = passphrase.filter(|value| !value.is_empty()).or_else(|| {
        if matches!(profile.auth, super::config::SshAuth::Key) {
            secrets.get_passphrase(&profile.id).ok().flatten()
        } else {
            None
        }
    });

    // connect_session needs the hub for emitting events and accessing known_hosts.
    // We cannot easily move &SshHub into a 'static future, so we call it directly
    // on the current runtime (it's already async).
    let handle =
        session::connect_session(&hub, &profile, password.as_deref(), passphrase.as_deref())
            .await?;

    let info = handle.info();
    hub.sessions.insert(profile_id.clone(), handle);
    hub.emit_session(&info);
    Ok(info)
}

#[tauri::command]
pub async fn ssh_disconnect(hub: State<'_, SshHub>, profile_id: String) -> Result<(), String> {
    if let Some((_, handle)) = hub.sessions.remove(&profile_id) {
        handle
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        {
            let guard = handle.inner.lock().await;
            let _ = guard
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
        hub.forwards.stop_all(&profile_id);
        hub.emit_session(&session::SshSessionInfo::disconnected(&handle.profile, ""));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_sessions(hub: State<'_, SshHub>) -> Result<Vec<SshSessionInfo>, String> {
    Ok(hub
        .sessions
        .iter()
        .map(|entry| entry.value().info())
        .collect())
}

#[tauri::command]
pub async fn ssh_home(hub: State<'_, SshHub>, profile_id: String) -> Result<String, String> {
    let handle = hub
        .sessions
        .get(&profile_id)
        .ok_or_else(err_not_connected)?;
    Ok(handle.home.clone())
}

// ───────────────────────────── Files ─────────────────────────────

#[tauri::command]
pub async fn ssh_list_dir(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<RemoteDirList, String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::list_dir(&sftp, &profile_id, &path).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_stat(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<RemoteStat, String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::stat(&sftp, &path).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_read_file(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<OpenedFile, String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::read_file(&sftp, &profile_id, &path).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_write_file(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
    content: String,
    meta: crate::codec::FileMeta,
    allow_lossy: Option<bool>,
) -> Result<WriteResult, String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    let allow_lossy = allow_lossy.unwrap_or(false);
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::write_file(&sftp, &profile_id, &path, &content, &meta, allow_lossy).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_mkdir(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<(), String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::mkdir(&sftp, &path).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_create_file(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<(), String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::create_file(&sftp, &path).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_rename(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
    name: String,
) -> Result<RenameResult, String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::rename(&sftp, &profile_id, &path, &name).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_delete(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<(), String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::delete(&sftp, &path).await
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn ssh_upload(
    hub: State<'_, SshHub>,
    profile_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<TransferId, String> {
    let local = PathBuf::from(&local_path);
    if !local.exists() {
        return Err("上传失败：本地文件不存在。".into());
    }
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    let emitter = hub.handle.clone();
    let transfer_id = run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::upload(&sftp, &profile_id, &local, &remote_dir, move |event| {
                let _ = emitter.emit("ssh-transfer", event);
            })
            .await
        })
        .await
    })
    .await?;
    Ok(serde_json::json!({ "transferId": transfer_id }))
}

#[tauri::command]
pub async fn ssh_download(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
    local_path: String,
) -> Result<TransferId, String> {
    let local = PathBuf::from(&local_path);
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    let emitter = hub.handle.clone();
    let transfer_id = run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::download(&sftp, &profile_id, &path, &local, move |event| {
                let _ = emitter.emit("ssh-transfer", event);
            })
            .await
        })
        .await
    })
    .await?;
    Ok(serde_json::json!({ "transferId": transfer_id }))
}

/// Read a remote image as base64 so the preview and HTML export can inline it.
#[tauri::command]
pub async fn ssh_read_binary_base64(
    hub: State<'_, SshHub>,
    profile_id: String,
    path: String,
) -> Result<String, String> {
    let handle = get_session(&hub, &profile_id)?;
    let runtime = hub.runtime.clone();
    run(runtime, async move {
        with_session(handle, |handle| async move {
            let sftp = files::open_sftp(&handle).await?;
            files::read_binary_base64(&sftp, &path).await
        })
        .await
    })
    .await
}

// ───────────────────────────── Forwards ─────────────────────────────

#[tauri::command]
pub async fn ssh_forward_add(
    hub: State<'_, SshHub>,
    profile_id: String,
    spec: ForwardSpec,
) -> Result<ForwardInfo, String> {
    let handle = get_session(&hub, &profile_id)?;
    let info = match &spec {
        ForwardSpec::Local { .. } => {
            super::forward::start_local_forward(&hub.forwards, &handle, &profile_id, spec).await
        }
        ForwardSpec::Dynamic { .. } => {
            super::forward::start_dynamic_forward(&hub.forwards, &handle, &profile_id, spec).await
        }
        ForwardSpec::Remote { .. } => {
            super::forward::start_remote_forward(&hub.forwards, &handle, &profile_id, spec).await
        }
    }?;
    hub.emit_forward_update(&profile_id, &hub.forwards.list(&profile_id));
    Ok(info)
}

#[tauri::command]
pub async fn ssh_forward_stop(
    hub: State<'_, SshHub>,
    profile_id: String,
    forward_id: String,
) -> Result<(), String> {
    hub.forwards.stop(&profile_id, &forward_id)?;
    hub.emit_forward_update(&profile_id, &hub.forwards.list(&profile_id));
    Ok(())
}

#[tauri::command]
pub async fn ssh_forward_list(
    hub: State<'_, SshHub>,
    profile_id: String,
) -> Result<Vec<ForwardInfo>, String> {
    Ok(hub.forwards.list(&profile_id))
}

// ───────────────────────────── Known hosts ─────────────────────────────

#[tauri::command]
pub async fn ssh_forget_host(
    hub: State<'_, SshHub>,
    host: String,
    port: u16,
) -> Result<(), String> {
    hub.known_hosts.forget(&host, port)
}
