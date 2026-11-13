//! SFTP file operations. All paths are remote POSIX absolute paths; the returned
//! `path` fields are ssh URIs (`ssh://<profileId>/<posix_path>`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::codec::{self, FileMeta};

use super::session::SessionHandle;

/// Remote edit cap: refuse files larger than this to avoid loading huge buffers.
const REMOTE_EDIT_LIMIT: u64 = 10 * 1024 * 1024;
/// Listing cap per directory level (matches the local tree limit).
pub const LIST_LIMIT: usize = 2_000;
/// Transfer chunk size (鈮?56 KB as required by the contract).
const TRANSFER_CHUNK: usize = 256 * 1024;
/// Max progress events per second (鈮? Hz).
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirList {
    pub entries: Vec<RemoteEntry>,
    pub truncated: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStat {
    pub size: u64,
    pub mtime_ms: u64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub meta: FileMeta,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub meta: FileMeta,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTransferEvent {
    pub transfer_id: String,
    pub profile_id: String,
    pub kind: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub error: String,
}

fn ssh_uri(profile_id: &str, posix_path: &str) -> String {
    format!("ssh://{profile_id}{posix_path}")
}

fn basename(posix_path: &str) -> String {
    posix_path
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(posix_path)
        .to_string()
}

/// A Windows OpenSSH server answers with paths such as `C:/Users/name`, so an
/// absolute path may start with `/` or with a drive letter. Everything else
/// (empty, relative) is rejected before it reaches the server.
fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("远程路径无效。".into());
    }
    let posix_absolute = path.starts_with('/');
    let drive_absolute = {
        let bytes = path.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\')
    };
    if !posix_absolute && !drive_absolute {
        return Err("远程路径无效。".into());
    }
    Ok(())
}

fn io_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}：{error}")
}

/// Modification time in milliseconds. `russh-sftp` exposes it as a
/// `SystemTime`; a missing or pre-epoch value becomes 0 so the UI can tell
/// "unknown" apart from "long ago".
fn file_mtime_ms(attrs: &russh_sftp::client::fs::Metadata) -> u64 {
    attrs
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// List one directory level. Directories sort before files; both groups sort
/// case-insensitively. Dot-files are included; non-regular types are skipped.
pub async fn list_dir(
    sftp: &SftpSession,
    _profile_id: &str,
    path: &str,
) -> Result<RemoteDirList, String> {
    validate_remote_path(path)?;
    let raw = sftp
        .read_dir(path)
        .await
        .map_err(|error| io_error("读取失败", error))?;

    let mut entries: Vec<RemoteEntry> = Vec::new();
    for entry in raw {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs = entry.metadata();
        let is_dir = attrs.file_type().is_dir();
        let is_file = attrs.file_type().is_file();
        if !is_dir && !is_file {
            continue;
        }
        let kind = if is_dir { "dir" } else { "file" };
        let full_path = entry.path();
        entries.push(RemoteEntry {
            name: name.clone(),
            path: full_path,
            kind: kind.to_string(),
            size: attrs.len(),
            mtime_ms: attrs
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        });
    }

    entries.sort_by(|left, right| {
        let kind_cmp = right.kind.cmp(&left.kind); // "file" > "dir" 鈫?dirs first
        kind_cmp
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });

    let truncated = entries.len() > LIST_LIMIT;
    entries.truncate(LIST_LIMIT);
    Ok(RemoteDirList {
        entries,
        truncated,
        limit: LIST_LIMIT,
    })
}

pub async fn stat(sftp: &SftpSession, path: &str) -> Result<RemoteStat, String> {
    validate_remote_path(path)?;
    let attrs = sftp
        .metadata(path)
        .await
        .map_err(|error| io_error("读取失败", error))?;
    let kind = if attrs.file_type().is_dir() {
        "dir"
    } else if attrs.file_type().is_file() {
        "file"
    } else {
        return Err("远程路径无效。".into());
    };
    Ok(RemoteStat {
        size: attrs.len(),
        mtime_ms: attrs
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        kind: kind.to_string(),
    })
}

pub async fn read_file(
    sftp: &SftpSession,
    profile_id: &str,
    path: &str,
) -> Result<OpenedFile, String> {
    validate_remote_path(path)?;
    let attrs = sftp
        .metadata(path)
        .await
        .map_err(|error| io_error("读取失败", error))?;
    if !attrs.file_type().is_file() {
        return Err("所选路径不是文件。".into());
    }
    let size = attrs.len();
    if size > REMOTE_EDIT_LIMIT {
        return Err(format!(
            "远程编辑上限为 {} MB，该文件 {:.1} MB；请下载后查看。",
            REMOTE_EDIT_LIMIT / (1024 * 1024),
            size as f64 / (1024.0 * 1024.0)
        ));
    }

    let mut handle = sftp
        .open(path)
        .await
        .map_err(|error| io_error("读取失败", error))?;
    let mut bytes = Vec::with_capacity(size as usize);
    handle
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| io_error("读取失败", error))?;

    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        let utf16 = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
        if !utf16 {
            return Err("该文件包含二进制内容（NUL 字节），已拒绝以文本方式打开。".into());
        }
    }

    let decoded = codec::decode(&bytes);
    let mtime_ms = file_mtime_ms(&attrs);
    Ok(OpenedFile {
        path: ssh_uri(profile_id, path),
        name: basename(path),
        content: decoded.content,
        meta: decoded.meta,
        size,
        mtime_ms,
    })
}

pub async fn write_file(
    sftp: &SftpSession,
    _profile_id: &str,
    path: &str,
    content: &str,
    meta: &FileMeta,
    allow_lossy: bool,
) -> Result<WriteResult, String> {
    validate_remote_path(path)?;
    if meta.lossy && !allow_lossy {
        return Err("该文件在打开时包含无法解码的字节，直接保存会用替换字符覆盖原数据。".into());
    }

    let encoded = codec::encode(content, meta)?;
    // NOTE: russh-sftp 2.4 does not expose set_mode; we preserve permissions
    // by writing to a temp file and renaming (the rename keeps the target's
    // existing permissions on most SFTP servers).

    let tmp_path = format!("{path}.{}.tmp", Uuid::new_v4());
    let result = async {
        let mut handle = sftp
            .create(&tmp_path)
            .await
            .map_err(|error| io_error("保存失败", error))?;
        handle
            .write_all(&encoded)
            .await
            .map_err(|error| io_error("保存失败", error))?;
        handle
            .flush()
            .await
            .map_err(|error| io_error("保存失败", error))?;
        drop(handle);
        sftp.rename(&tmp_path, path)
            .await
            .map_err(|error| io_error("保存失败", error))?;
        Ok::<_, String>(())
    }
    .await;

    if result.is_err() {
        let _ = sftp.remove_file(&tmp_path).await;
        result?;
    }

    let attrs = sftp
        .metadata(path)
        .await
        .map_err(|error| io_error("保存失败", error))?;
    let mut written_meta = meta.clone();
    written_meta.mixed_eol = false;
    Ok(WriteResult {
        meta: written_meta,
        size: encoded.len() as u64,
        mtime_ms: file_mtime_ms(&attrs),
    })
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    sftp.create_dir(path)
        .await
        .map_err(|error| io_error("创建文件夹失败", error))
}

pub async fn create_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    if sftp.metadata(path).await.is_ok() {
        return Err(format!("目标已存在：{}", basename(path)));
    }
    let mut handle = sftp
        .create(path)
        .await
        .map_err(|error| io_error("创建文件失败", error))?;
    handle
        .flush()
        .await
        .map_err(|error| io_error("创建文件失败", error))?;
    Ok(())
}

pub async fn rename(
    sftp: &SftpSession,
    profile_id: &str,
    path: &str,
    new_name: &str,
) -> Result<RenameResult, String> {
    validate_remote_path(path)?;
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空。".into());
    }
    if trimmed.contains('/') {
        return Err("文件名无效。".into());
    }
    let parent = path.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
    if parent.is_empty() {
        return Err("远程路径无效。".into());
    }
    let target = format!("{parent}/{trimmed}");
    if target != path {
        if sftp.metadata(&target).await.is_ok() {
            return Err(format!("目标已存在：{trimmed}"));
        }
        sftp.rename(path, &target)
            .await
            .map_err(|error| io_error("重命名失败", error))?;
    }
    Ok(RenameResult {
        path: ssh_uri(profile_id, &target),
        name: trimmed.to_string(),
    })
}

pub async fn delete(sftp: &SftpSession, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    let attrs = sftp
        .metadata(path)
        .await
        .map_err(|error| io_error("删除失败", error))?;
    if attrs.file_type().is_dir() {
        remove_dir_recursive(sftp, path).await
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|error| io_error("删除失败", error))
    }
}

async fn remove_dir_recursive(sftp: &SftpSession, path: &str) -> Result<(), String> {
    // `read_dir` returns an iterator that borrows no lock, so collect the
    // children first: recursing while holding the iterator would borrow `sftp`
    // twice.
    let mut children: Vec<(String, bool)> = Vec::new();
    {
        let entries = sftp
            .read_dir(path)
            .await
            .map_err(|error| io_error("删除失败", error))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let is_dir = entry.metadata().file_type().is_dir();
            children.push((entry.path(), is_dir));
        }
    }
    for (child, is_dir) in children {
        if is_dir {
            Box::pin(remove_dir_recursive(sftp, &child)).await?;
        } else {
            sftp.remove_file(&child)
                .await
                .map_err(|error| io_error("删除失败", error))?;
        }
    }
    sftp.remove_dir(path)
        .await
        .map_err(|error| io_error("删除失败", error))
}

pub async fn upload<F>(
    sftp: &SftpSession,
    profile_id: &str,
    local_path: &std::path::Path,
    remote_dir: &str,
    emit: F,
) -> Result<String, String>
where
    F: Fn(&SshTransferEvent) + Send + Sync,
{
    validate_remote_path(remote_dir)?;
    let name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "上传失败：本地路径无效。".to_string())?
        .to_string();
    let remote_path = if remote_dir.ends_with('/') {
        format!("{remote_dir}{name}")
    } else {
        format!("{remote_dir}/{name}")
    };

    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(|error| format!("上传失败：{error}"))?;
    let total = file
        .metadata()
        .await
        .map_err(|error| format!("上传失败：{error}"))?
        .len();

    let transfer_id = Uuid::new_v4().to_string();
    let transferred = AtomicU64::new(0);
    let mut reader = file;
    let mut remote = sftp
        .create(&remote_path)
        .await
        .map_err(|error| format!("上传失败：{error}"))?;

    let mut buffer = vec![0u8; TRANSFER_CHUNK];
    let mut last_emit = Instant::now();
    let result = loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break Ok(()),
            Ok(n) => {
                if let Err(error) = remote.write_all(&buffer[..n]).await {
                    break Err(format!("上传失败：{error}"));
                }
                let done = transferred.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
                if last_emit.elapsed() >= PROGRESS_MIN_INTERVAL {
                    emit(&SshTransferEvent {
                        transfer_id: transfer_id.clone(),
                        profile_id: profile_id.to_string(),
                        kind: "upload".into(),
                        name: name.clone(),
                        transferred: done,
                        total,
                        done: false,
                        error: String::new(),
                    });
                    last_emit = Instant::now();
                }
            }
            Err(error) => break Err(format!("上传失败：{error}")),
        }
    };

    if let Err(error) = result {
        let _ = sftp.remove_file(&remote_path).await;
        emit(&SshTransferEvent {
            transfer_id: transfer_id.clone(),
            profile_id: profile_id.to_string(),
            kind: "upload".into(),
            name: name.clone(),
            transferred: transferred.load(Ordering::SeqCst),
            total,
            done: true,
            error: error.clone(),
        });
        return Err(error);
    }

    let _ = remote.flush().await;
    emit(&SshTransferEvent {
        transfer_id: transfer_id.clone(),
        profile_id: profile_id.to_string(),
        kind: "upload".into(),
        name,
        transferred: total,
        total,
        done: true,
        error: String::new(),
    });
    Ok(transfer_id)
}

pub async fn download<F>(
    sftp: &SftpSession,
    profile_id: &str,
    remote_path: &str,
    local_path: &std::path::Path,
    emit: F,
) -> Result<String, String>
where
    F: Fn(&SshTransferEvent) + Send + Sync,
{
    validate_remote_path(remote_path)?;
    if tokio::fs::metadata(local_path).await.is_ok() {
        return Err(format!("下载失败：目标已存在：{}", local_path.display()));
    }
    let attrs = sftp
        .metadata(remote_path)
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    if !attrs.file_type().is_file() {
        return Err("下载失败：远程路径不是文件。".into());
    }
    let total = attrs.len();
    let name = basename(remote_path);
    let transfer_id = Uuid::new_v4().to_string();

    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
    }
    let tmp_local = local_path.with_extension(format!("{}.download", Uuid::new_v4()));
    let result = async {
        let mut writer = tokio::fs::File::create(&tmp_local)
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
        let mut buffer = vec![0u8; TRANSFER_CHUNK];
        let mut transferred = 0u64;
        let mut last_emit = Instant::now();
        loop {
            match remote.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    writer
                        .write_all(&buffer[..n])
                        .await
                        .map_err(|error| format!("下载失败：{error}"))?;
                    transferred += n as u64;
                    if last_emit.elapsed() >= PROGRESS_MIN_INTERVAL {
                        emit(&SshTransferEvent {
                            transfer_id: transfer_id.clone(),
                            profile_id: profile_id.to_string(),
                            kind: "download".into(),
                            name: name.clone(),
                            transferred,
                            total,
                            done: false,
                            error: String::new(),
                        });
                        last_emit = Instant::now();
                    }
                }
                Err(error) => return Err(format!("下载失败：{error}")),
            }
        }
        writer
            .flush()
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
        drop(writer);
        tokio::fs::rename(&tmp_local, local_path)
            .await
            .map_err(|error| format!("下载失败：{error}"))?;
        Ok(transferred)
    }
    .await;

    match result {
        Ok(done_bytes) => {
            emit(&SshTransferEvent {
                transfer_id: transfer_id.clone(),
                profile_id: profile_id.to_string(),
                kind: "download".into(),
                name,
                transferred: done_bytes,
                total,
                done: true,
                error: String::new(),
            });
            Ok(transfer_id)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp_local).await;
            emit(&SshTransferEvent {
                transfer_id: transfer_id.clone(),
                profile_id: profile_id.to_string(),
                kind: "download".into(),
                name,
                transferred: 0,
                total,
                done: true,
                error: error.clone(),
            });
            Err(error)
        }
    }
}

/// Cap for a remote image inlined into the preview, matching the local reader.
const MAX_REMOTE_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// Read a remote file as base64 so the preview and the HTML export can inline it
/// as a data URI. Mirrors `read_binary_base64` on the local side.
pub async fn read_binary_base64(sftp: &SftpSession, path: &str) -> Result<String, String> {
    use base64::Engine as _;

    validate_remote_path(path)?;
    let attrs = sftp
        .metadata(path)
        .await
        .map_err(|error| io_error("读取失败", error))?;
    if !attrs.file_type().is_file() {
        return Err("所选路径不是文件。".into());
    }
    if attrs.len() > MAX_REMOTE_IMAGE_BYTES {
        return Err(format!(
            "图片过大（上限 {} MB）。",
            MAX_REMOTE_IMAGE_BYTES / (1024 * 1024)
        ));
    }

    let mut handle = sftp
        .open(path)
        .await
        .map_err(|error| io_error("读取失败", error))?;
    let mut bytes = Vec::new();
    handle
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| io_error("读取失败", error))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Helper to obtain an SFTP session from a live SSH handle. The caller must hold
/// the session lock; this function opens a dedicated SFTP channel inside it.
pub async fn open_sftp(handle: &SessionHandle) -> Result<SftpSession, String> {
    let guard = handle.inner.lock().await;
    let channel = guard
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 会话未连接：{error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("SSH 会话未连接：{error}"))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("SSH 会话未连接：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{basename, validate_remote_path};

    #[test]
    fn remote_paths_accept_posix_and_windows_absolute_forms() {
        // POSIX servers.
        assert!(validate_remote_path("/home/deploy").is_ok());
        assert!(validate_remote_path("/").is_ok());
        // Windows OpenSSH answers with drive-letter paths.
        assert!(validate_remote_path("C:/Users/admin").is_ok());
        assert!(validate_remote_path("D:\\\\data").is_ok());
        // Empty or relative paths never reach the server.
        assert!(validate_remote_path("").is_err());
        assert!(validate_remote_path("relative/path").is_err());
        assert!(validate_remote_path("./x").is_err());
    }

    #[test]
    fn basename_returns_the_last_segment() {
        assert_eq!(basename("/home/me/notes.md"), "notes.md");
        assert_eq!(basename("C:/Users/admin/a.txt"), "a.txt");
        assert_eq!(basename("/"), "/");
    }
}
