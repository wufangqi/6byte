use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::codec::{self, FileMeta};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResponse {
    pub path: String,
    pub name: String,
    pub content: String,
    pub meta: FileMeta,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResponse {
    pub meta: FileMeta,
    pub size: u64,
    pub mtime_ms: u64,
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadFileResponse, String> {
    let path = PathBuf::from(path);
    let bytes = fs::read(&path).map_err(|error| format!("读取失败：{error}"))?;
    let decoded = codec::decode(&bytes);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名")
        .to_string();

    Ok(ReadFileResponse {
        path: path.to_string_lossy().to_string(),
        name,
        content: decoded.content,
        meta: decoded.meta,
        size: bytes.len() as u64,
        mtime_ms: mtime_ms(&path),
    })
}

/// Write `content` back to `path` using the encoding metadata captured at open time.
/// The data hits the disk atomically (temp file + rename).
#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    meta: FileMeta,
) -> Result<WriteFileResponse, String> {
    let path = PathBuf::from(path);
    let bytes = codec::encode(&content, &meta)?;

    atomic_write(&path, &bytes).map_err(|error| format!("保存失败：{error}"))?;

    Ok(WriteFileResponse {
        meta,
        size: bytes.len() as u64,
        mtime_ms: mtime_ms(&path),
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("untitled");
    let tmp_path = parent.join(format!(".{file_name}.{stamp}.tmp"));

    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, path)
    })();

    if written.is_err() {
        let _ = fs::remove_file(&tmp_path);
        // Fallback for targets that reject rename (e.g. read-only or locked files
        // on Windows). `fs::write` will surface a proper error if this also fails.
        return fs::write(path, bytes);
    }

    Ok(())
}