use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::bigfile::{self, FileLevel, LargeFileCache};
use crate::codec::{self, FileMeta};
use crate::grep::GrepResponse;
use crate::watcher::FileWatcher;

/// Refuse files larger than this until the staged loader (M1, ADR-011) exists.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// How many leading bytes are inspected for binary content.
const SNIFF_BYTES: usize = 8 * 1024;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileResponse {
    pub path: String,
    pub name: String,
}

/// Result of `open_document`: either a fully loaded text buffer or a read-only
/// large-file descriptor whose content is streamed through `read_range`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResponse {
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<ReadFileResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<bigfile::LargeFileInfo>,
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// NUL bytes outside a UTF-16 BOM file almost always mean binary content.
/// UTF-16 text legitimately contains NUL bytes, so the BOM exempts it.
fn looks_binary(bytes: &[u8]) -> bool {
    let utf16 = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
    !utf16 && bytes.iter().take(SNIFF_BYTES).any(|byte| *byte == 0)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadFileResponse, String> {
    let path = PathBuf::from(&path);
    let metadata = fs::metadata(&path).map_err(|error| format!("读取失败：{error}"))?;

    if !metadata.is_file() {
        return Err("所选路径不是文件。".to_string());
    }

    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{:.1} MB），当前版本上限为 {} MB；大文件支持将在 M1 提供。",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }

    let mut head = Vec::new();
    fs::File::open(&path)
        .and_then(|file| file.take(SNIFF_BYTES as u64).read_to_end(&mut head))
        .map_err(|error| format!("读取失败：{error}"))?;
    if looks_binary(&head) {
        return Err("该文件包含二进制内容（NUL 字节），已拒绝以文本方式打开。".to_string());
    }

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

/// Open a file with staged loading: L0/L1 are returned whole, L2 becomes a
/// read-only range viewer and L3 is rejected until the mmap loader lands.
#[tauri::command]
pub fn open_document(
    path: String,
    cache: tauri::State<'_, LargeFileCache>,
) -> Result<DocumentResponse, String> {
    open_document_inner(path, &cache)
}

fn open_document_inner(path: String, cache: &LargeFileCache) -> Result<DocumentResponse, String> {
    let path_buf = PathBuf::from(&path);
    let metadata = fs::metadata(&path_buf).map_err(|error| format!("读取失败：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件。".to_string());
    }

    match bigfile::classify(metadata.len()) {
        FileLevel::L0 | FileLevel::L1 => Ok(DocumentResponse {
            mode: "text",
            file: Some(read_file(path)?),
            info: None,
        }),
        FileLevel::L2 => Ok(DocumentResponse {
            mode: "large",
            file: None,
            info: Some(cache.info(&path_buf)?),
        }),
        FileLevel::L3 => {
            if metadata.len() > bigfile::MAX_READ_ONLY_BYTES {
                Err(format!(
                    "文件过大（{:.0} MB），只读预览上限为 {} MB。",
                    metadata.len() as f64 / (1024.0 * 1024.0),
                    bigfile::MAX_READ_ONLY_BYTES / (1024 * 1024)
                ))
            } else {
                Ok(DocumentResponse {
                    mode: "large",
                    file: None,
                    info: Some(cache.info(&path_buf)?),
                })
            }
        }
    }
}

/// Decode lines `start_line..end_line` (0-based, end exclusive) of a large file.
#[tauri::command]
pub fn read_range(
    path: String,
    start_line: u64,
    end_line: u64,
    cache: tauri::State<'_, LargeFileCache>,
) -> Result<bigfile::LineRange, String> {
    cache.read_lines(Path::new(&path), start_line, end_line)
}

/// Search a directory tree with a Rust `regex`. See `grep::grep` for the rules
/// (binary files, VCS directories and oversized files are skipped).
#[tauri::command]
pub fn grep_files(
    root: String,
    pattern: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<GrepResponse, String> {
    crate::grep::grep(
        Path::new(&root),
        &pattern,
        case_sensitive.unwrap_or(false),
        max_results,
    )
}

/// Start watching a file for external changes; events arrive as `file-changed`.
#[tauri::command]
pub fn watch_file(path: String, watcher: tauri::State<'_, FileWatcher>) -> Result<(), String> {
    watcher.watch(Path::new(&path))
}

/// Stop watching a file (tab closed or replaced).
#[tauri::command]
pub fn unwatch_file(path: String, watcher: tauri::State<'_, FileWatcher>) -> Result<(), String> {
    watcher.unwatch(Path::new(&path));
    Ok(())
}

/// Save a pasted image into `<dir>/assets/` and return the relative path used in Markdown.
#[tauri::command]
pub fn save_asset(dir: String, filename: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片数据为空。".to_string());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "图片过大（上限 {} MB）。",
            MAX_ASSET_BYTES / (1024 * 1024)
        ));
    }
    let base = PathBuf::from(&dir);
    if !base.is_dir() {
        return Err("目标文件夹不存在。".to_string());
    }

    let safe_name = sanitize_asset_name(&filename)?;
    let assets = base.join("assets");
    fs::create_dir_all(&assets).map_err(|error| format!("创建 assets 目录失败：{error}"))?;
    let target = assets.join(&safe_name);
    atomic_write(&target, &bytes).map_err(|error| format!("写入图片失败：{error}"))?;

    Ok(format!("assets/{safe_name}"))
}

const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;

/// Keep only a flat, safe file name: no directories, no leading dots, ASCII only.
fn sanitize_asset_name(name: &str) -> Result<String, String> {
    let file_name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let cleaned: String = file_name
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .take(80)
        .collect();
    if cleaned.is_empty() || cleaned.starts_with('.') {
        return Err("图片文件名无效。".to_string());
    }
    Ok(cleaned)
}

const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// Read a local image as base64 so the preview and HTML export can inline it as a data URI.
#[tauri::command]
pub fn read_binary_base64(path: String) -> Result<String, String> {
    use base64::Engine as _;

    let path = PathBuf::from(&path);
    let metadata = fs::metadata(&path).map_err(|error| format!("读取失败：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件。".to_string());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（上限 {} MB）。",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&path).map_err(|error| format!("读取失败：{error}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
/// Write `content` back to `path` using the encoding metadata captured at open time.
/// The data hits the disk atomically (temp file + rename).
///
/// A file that was decoded lossily must not be overwritten silently: the caller has
/// to pass `allow_lossy = true` after the user confirmed the data loss.
#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    meta: FileMeta,
    allow_lossy: Option<bool>,
) -> Result<WriteFileResponse, String> {
    if meta.lossy && !allow_lossy.unwrap_or(false) {
        return Err(
            "该文件在打开时包含无法解码的字节，直接保存会用替换字符覆盖原数据。".to_string(),
        );
    }

    let path = PathBuf::from(&path);
    let bytes = codec::encode(&content, &meta)?;

    atomic_write(&path, &bytes).map_err(|error| format!("保存失败：{error}"))?;

    // The bytes on disk are now normalized to a single line ending.
    let mut meta = meta;
    meta.mixed_eol = false;

    Ok(WriteFileResponse {
        meta,
        size: bytes.len() as u64,
        mtime_ms: mtime_ms(&path),
    })
}

/// Current on-disk size and modification time, used to detect external edits
/// before overwriting a file.
#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
    let path = PathBuf::from(&path);
    let metadata = fs::metadata(&path).map_err(|error| format!("读取失败：{error}"))?;
    Ok(FileStat {
        size: metadata.len(),
        mtime_ms: mtime_ms(&path),
    })
}

/// Validate a user-supplied file name. Only the last segment is accepted, so a
/// rename can never move a file out of its folder.
fn sanitize_file_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空。".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("文件名无效。".to_string());
    }
    if trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("文件名不能包含 \\ / : * ? \" < > | 这些字符。".to_string());
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return Err("文件名包含无效字符。".to_string());
    }
    if trimmed.len() > 255 {
        return Err("文件名过长。".to_string());
    }
    Ok(trimmed.to_string())
}

/// Rename a file inside its current folder. The open buffer is untouched; the
/// caller keeps editing and saving through the returned path.
#[tauri::command]
pub fn rename_file(path: String, name: String) -> Result<RenameFileResponse, String> {
    let source = PathBuf::from(&path);
    let metadata =
        fs::metadata(&source).map_err(|error| format!("文件不存在或无法访问：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件。".to_string());
    }

    let new_name = sanitize_file_name(&name)?;
    let parent = source
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "无法定位文件所在目录。".to_string())?;
    let target = parent.join(&new_name);

    if target == source {
        return Ok(RenameFileResponse {
            path: path.clone(),
            name: new_name,
        });
    }
    if target.exists() {
        return Err(format!("「{new_name}」已存在。"));
    }

    fs::rename(&source, &target).map_err(|error| format!("重命名失败：{error}"))?;

    Ok(RenameFileResponse {
        path: target.to_string_lossy().to_string(),
        name: new_name,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ainative-test-{tag}-{stamp}.txt"))
    }

    fn utf8_meta(lossy: bool) -> FileMeta {
        FileMeta {
            charset: "UTF-8".into(),
            bom: false,
            eol: codec::Eol::Lf,
            lossy,
            mixed_eol: false,
        }
    }

    #[test]
    fn lossy_save_requires_explicit_permission() {
        let path = temp_path("lossy");
        let path_string = path.to_string_lossy().to_string();
        let meta = utf8_meta(true);

        assert!(write_file(path_string.clone(), "a\u{FFFD}b".into(), meta.clone(), None).is_err());
        assert!(!path.exists(), "rejected save must not touch the disk");

        let response = write_file(path_string, "a\u{FFFD}b".into(), meta, Some(true))
            .expect("explicit permission must allow the save");
        assert_eq!(response.size, "a\u{FFFD}b".len() as u64);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn save_normalizes_mixed_eol_and_clears_flag() {
        let path = temp_path("mixed-eol");
        let path_string = path.to_string_lossy().to_string();
        let mut meta = utf8_meta(false);
        meta.eol = codec::Eol::Crlf;
        meta.mixed_eol = true;

        let response = write_file(path_string, "a\r\nb\nc\r\n".into(), meta, None).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc\r\n");
        assert!(!response.meta.mixed_eol, "disk is uniform after save");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_binary_content() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary("你好，世界".as_bytes()));
        assert!(!looks_binary(b""));
        // UTF-16 text legitimately contains NUL bytes when the BOM is present.
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "hi".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(!looks_binary(&utf16));
    }

    #[test]
    fn stat_file_reports_size_and_mtime() {
        let path = temp_path("stat");
        fs::write(&path, b"hello").unwrap();
        let stat = stat_file(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(stat.size, 5);
        assert!(stat.mtime_ms > 0);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn sanitize_file_name_rejects_paths_and_dot_names() {
        assert_eq!(sanitize_file_name("  笔记.md ").unwrap(), "笔记.md");
        assert!(sanitize_file_name("").is_err());
        assert!(sanitize_file_name("..").is_err());
        assert!(sanitize_file_name("../escape.md").is_err());
        assert!(sanitize_file_name("sub/name.md").is_err());
        assert!(sanitize_file_name("bad:name.md").is_err());
    }

    #[test]
    fn rename_file_keeps_the_file_in_its_folder() {
        let path = temp_path("rename");
        fs::write(&path, b"hello").unwrap();
        let folder = path.parent().unwrap();

        let response =
            rename_file(path.to_string_lossy().to_string(), "renamed.md".into()).unwrap();
        let renamed = folder.join("renamed.md");
        assert_eq!(response.name, "renamed.md");
        assert_eq!(PathBuf::from(&response.path), renamed);
        assert!(!path.exists());
        assert_eq!(fs::read(&renamed).unwrap(), b"hello");

        let collision = rename_file(renamed.to_string_lossy().to_string(), "renamed.md".into())
            .expect("renaming to the same name is a no-op");
        assert_eq!(collision.path, renamed.to_string_lossy().to_string());

        let _ = fs::remove_file(renamed);
    }

    #[test]
    fn rename_file_refuses_a_missing_path_and_a_directory() {
        let missing = temp_path("rename-missing");
        let missing_error =
            rename_file(missing.to_string_lossy().to_string(), "next.md".into()).unwrap_err();
        assert!(missing_error.contains("不存在"), "{missing_error}");

        let directory = std::env::temp_dir().join(format!(
            "ainative-test-rename-dir-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let directory_error =
            rename_file(directory.to_string_lossy().to_string(), "next".into()).unwrap_err();
        assert!(directory_error.contains("不是文件"), "{directory_error}");
        let _ = fs::remove_dir(directory);
    }

    #[test]
    fn rename_file_refuses_to_overwrite_an_existing_file() {
        let first = temp_path("rename-a");
        let second = temp_path("rename-b");
        fs::write(&first, b"a").unwrap();
        fs::write(&second, b"b").unwrap();
        let target_name = second.file_name().unwrap().to_string_lossy().to_string();

        let error = rename_file(first.to_string_lossy().to_string(), target_name).unwrap_err();
        assert!(error.contains("已存在"), "{error}");
        assert_eq!(fs::read(&second).unwrap(), b"b");

        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn read_file_reads_gbk_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/gbk-crlf.txt");
        let file = read_file(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(file.meta.charset, "GBK");
        assert_eq!(file.meta.eol, codec::Eol::Crlf);
        assert!(!file.meta.mixed_eol);
        assert_eq!(file.name, "gbk-crlf.txt");
        assert!(file.size > 0);
    }

    #[test]
    fn read_file_rejects_binary_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/binary.bin");
        let error = read_file(path.to_string_lossy().to_string()).unwrap_err();
        assert!(error.contains("二进制"), "unexpected error: {error}");
    }

    #[test]
    fn read_file_rejects_oversized_files() {
        let path = temp_path("oversized");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(file);

        let error = read_file(path.to_string_lossy().to_string()).unwrap_err();
        assert!(error.contains("文件过大"), "unexpected error: {error}");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn open_document_loads_small_files_whole() {
        let path = temp_path("open-small");
        fs::write(&path, b"hello\nworld\n").unwrap();
        let response = open_document_inner(
            path.to_string_lossy().to_string(),
            &LargeFileCache::default(),
        )
        .unwrap();
        assert_eq!(response.mode, "text");
        let file = response.file.expect("text payload");
        assert_eq!(file.content, "hello\nworld\n");
        assert!(response.info.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn open_document_routes_large_files_to_the_range_viewer() {
        // A real 21 MB text file: must come back as a descriptor, not as content.
        let path = temp_path("open-large");
        let line = "0123456789\n";
        let mut content = String::with_capacity(bigfile::L2_MAX_BYTES as usize + 2048);
        while content.len() < bigfile::L2_MAX_BYTES as usize {
            content.push_str(line);
        }
        fs::write(&path, &content).unwrap();
        drop(content);

        let cache = LargeFileCache::default();
        let response = open_document_inner(path.to_string_lossy().to_string(), &cache).unwrap();

        assert_eq!(response.mode, "large");
        assert!(
            response.file.is_none(),
            "large files must not be shipped whole"
        );
        let info = response.info.expect("large descriptor");
        assert_eq!(info.size, fs::metadata(&path).unwrap().len());
        assert!(
            info.line_count > 1_000_000,
            "line count: {}",
            info.line_count
        );
        assert_eq!(info.meta.charset, "UTF-8");

        let first = cache.read_lines(&path, 0, 3).unwrap();
        assert_eq!(first.lines, vec!["0123456789"; 3]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn open_document_rejects_files_above_the_viewer_limit() {
        let path = temp_path("open-too-big");
        let file = fs::File::create(&path).unwrap();
        file.set_len(bigfile::MAX_READ_ONLY_BYTES + 1).unwrap();
        drop(file);

        let error = open_document_inner(
            path.to_string_lossy().to_string(),
            &LargeFileCache::default(),
        )
        .unwrap_err();
        assert!(error.contains("文件过大"), "unexpected error: {error}");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn read_binary_base64_encodes_file_bytes() {
        let path = temp_path("base64");
        fs::write(&path, [1u8, 2, 3]).unwrap();
        assert_eq!(
            read_binary_base64(path.to_string_lossy().to_string()).unwrap(),
            "AQID"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn read_binary_base64_rejects_oversized_files() {
        let path = temp_path("base64-big");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(file);
        let error = read_binary_base64(path.to_string_lossy().to_string()).unwrap_err();
        assert!(error.contains("图片过大"), "unexpected error: {error}");
        let _ = fs::remove_file(path);
    }
    #[test]
    fn atomic_write_replaces_existing_content() {
        let path = temp_path("atomic");
        fs::write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let _ = fs::remove_file(path);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ainative-asset-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_asset_writes_into_assets_dir() {
        let dir = temp_dir("write");
        let relative = save_asset(
            dir.to_string_lossy().to_string(),
            "shot.png".into(),
            vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A],
        )
        .unwrap();
        assert_eq!(relative, "assets/shot.png");
        assert_eq!(
            fs::read(dir.join("assets").join("shot.png")).unwrap(),
            vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_asset_sanitizes_the_file_name() {
        let dir = temp_dir("sanitize");
        let relative = save_asset(
            dir.to_string_lossy().to_string(),
            "../../evil name.png".into(),
            vec![1, 2, 3],
        )
        .unwrap();
        assert_eq!(relative, "assets/evilname.png");
        assert!(dir.join("assets").join("evilname.png").is_file());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_asset_rejects_empty_and_oversized_payloads() {
        let dir = temp_dir("limits");
        let base = dir.to_string_lossy().to_string();
        assert!(save_asset(base.clone(), "empty.png".into(), Vec::new()).is_err());
        assert!(save_asset(base, "huge.png".into(), vec![0u8; MAX_ASSET_BYTES + 1]).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_asset_rejects_missing_directories() {
        let dir = temp_dir("missing").join("nope");
        let error =
            save_asset(dir.to_string_lossy().to_string(), "a.png".into(), vec![1]).unwrap_err();
        assert!(
            error.contains("目标文件夹不存在"),
            "unexpected error: {error}"
        );
    }

    /// Not part of CI: `cargo test --release --lib perf_read_10mb -- --ignored --nocapture`
    /// measures the Rust open/save path, not CodeMirror rendering.
    #[test]
    #[ignore = "performance probe, run manually with --release --ignored --nocapture"]
    fn perf_read_10mb_file() {
        use std::time::Instant;

        let target_bytes = 10 * 1024 * 1024;
        let line = "2026-10-21T17:00:00Z INFO request served in 12ms path=/api/v1/items\n";
        let mut content = String::with_capacity(target_bytes + line.len());
        while content.len() < target_bytes {
            content.push_str(line);
        }

        let path = temp_path("perf");
        fs::write(&path, &content).unwrap();
        let path_string = path.to_string_lossy().to_string();

        let read_start = Instant::now();
        let opened = read_file(path_string.clone()).expect("read 10 MB file");
        println!(
            "read+decode 10 MB: {:?} ({} bytes, {} chars)",
            read_start.elapsed(),
            opened.size,
            opened.content.chars().count()
        );

        let write_start = Instant::now();
        write_file(path_string, opened.content, opened.meta, None).expect("save 10 MB file");
        println!("encode+atomic write 10 MB: {:?}", write_start.elapsed());

        let _ = fs::remove_file(path);
    }
}
