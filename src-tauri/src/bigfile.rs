//! Staged loading for large files (ADR-011, M1).
//!
//! L0/L1 files still go through the editor path (`read_file`), while L2 files
//! (20–100 MB) are served as read-only ranges: a line-offset index is built once
//! per (path, mtime) and ranges are decoded on demand, so the frontend never
//! receives the whole document.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use encoding_rs::Encoding;
use memmap2::Mmap;
use serde::Serialize;

use crate::codec::{self, FileMeta};

/// Files up to this size are edited normally (L0).
pub const L1_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// L1 upper bound: still loaded whole, but with reduced decorations.
pub const L2_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// L2 upper bound: read-only range viewer. Anything larger is rejected until the
/// mmap-backed L3 loader exists.
pub const L3_MAX_BYTES: u64 = 100 * 1024 * 1024;

const INDEX_SNIFF_BYTES: usize = 64 * 1024;
const READ_CHUNK_BYTES: usize = 256 * 1024;
/// A single `read_range` reply is capped so one enormous line cannot blow up the IPC.
const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHED_INDEXES: usize = 4;
/// Files above this size are read through a memory map instead of seek+read.
const MMAP_THRESHOLD_BYTES: u64 = 20 * 1024 * 1024;
/// Upper bound for the read-only viewer (beyond it we refuse with a clear message).
pub const MAX_READ_ONLY_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileLevel {
    L0,
    L1,
    L2,
    L3,
}

/// Classify by size only; content checks happen later.
pub fn classify(size: u64) -> FileLevel {
    if size <= L1_MAX_BYTES {
        FileLevel::L0
    } else if size <= L2_MAX_BYTES {
        FileLevel::L1
    } else if size <= L3_MAX_BYTES {
        FileLevel::L2
    } else {
        FileLevel::L3
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub meta: FileMeta,
    pub line_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start_line: u64,
    pub lines: Vec<String>,
}

struct IndexEntry {
    size: u64,
    mtime_ms: u64,
    meta: FileMeta,
    offsets: Arc<Vec<u64>>,
}

/// Caches line-offset indexes so scrolling does not rescan the file on every frame.
#[derive(Default)]
pub struct LargeFileCache {
    entries: Mutex<HashMap<PathBuf, Arc<IndexEntry>>>,
}

impl LargeFileCache {
    fn index(&self, path: &Path) -> Result<Arc<IndexEntry>, String> {
        let metadata = fs::metadata(path).map_err(|error| format!("读取失败：{error}"))?;
        if !metadata.is_file() {
            return Err("所选路径不是文件。".to_string());
        }
        let size = metadata.len();
        let mtime = mtime_ms(path);

        {
            let entries = self
                .entries
                .lock()
                .map_err(|_| "索引缓存已损坏".to_string())?;
            if let Some(entry) = entries.get(path) {
                if entry.size == size && entry.mtime_ms == mtime {
                    return Ok(Arc::clone(entry));
                }
            }
        }

        let entry = Arc::new(build_index(path, size, mtime)?);
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "索引缓存已损坏".to_string())?;
        if entries.len() >= MAX_CACHED_INDEXES {
            entries.clear();
        }
        entries.insert(path.to_path_buf(), Arc::clone(&entry));
        Ok(entry)
    }

    /// Open metadata for a large file without shipping its contents.
    pub fn info(&self, path: &Path) -> Result<LargeFileInfo, String> {
        let entry = self.index(path)?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("未命名")
            .to_string();
        Ok(LargeFileInfo {
            path: path.to_string_lossy().to_string(),
            name,
            size: entry.size,
            mtime_ms: entry.mtime_ms,
            meta: entry.meta.clone(),
            line_count: line_count_of(&entry.offsets, entry.size),
        })
    }

    /// Decode `start_line..end_line` (0-based, end exclusive) as text.
    pub fn read_lines(
        &self,
        path: &Path,
        start_line: u64,
        end_line: u64,
    ) -> Result<LineRange, String> {
        let entry = self.index(path)?;
        let line_count = line_count_of(&entry.offsets, entry.size);
        let start = start_line.min(line_count);
        let end = end_line.min(line_count).max(start);

        if start == end {
            return Ok(LineRange {
                start_line: start,
                lines: Vec::new(),
            });
        }

        if entry.meta.charset.starts_with("UTF-16") {
            return Err("大文件只读预览暂不支持 UTF-16 编码".to_string());
        }
        let encoding = Encoding::for_label(entry.meta.charset.as_bytes())
            .ok_or_else(|| format!("不支持的编码：{}", entry.meta.charset))?;

        let byte_start = entry.offsets[start as usize];
        let mut byte_end = if (end as usize) < entry.offsets.len() {
            entry.offsets[end as usize]
        } else {
            entry.size
        };
        byte_end = byte_end.min(byte_start + MAX_RANGE_BYTES);

        let use_mmap = entry.size > MMAP_THRESHOLD_BYTES;
        let buffer = read_span(path, byte_start, byte_end, use_mmap)?;

        let (text, _, _had_errors) = encoding.decode(&buffer);
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .collect();
        // A trailing newline produces an empty last element that is not a real line.
        if lines.len() > 1 && lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }

        Ok(LineRange {
            start_line: start,
            lines,
        })
    }
}

/// Read `[start, end)` either with a memory map (large files) or seek+read.
fn read_span(path: &Path, start: u64, end: u64, use_mmap: bool) -> Result<Vec<u8>, String> {
    if end < start {
        return Err("读取区间无效。".to_string());
    }
    let length = (end - start) as usize;

    if use_mmap {
        let file = File::open(path).map_err(|error| format!("读取失败：{error}"))?;
        // Safety: the map is read-only and we copy the requested bytes out
        // immediately; atomic saves replace the file instead of writing in place.
        let map = unsafe { Mmap::map(&file) }.map_err(|error| format!("内存映射失败：{error}"))?;
        let slice = map
            .get(start as usize..start as usize + length)
            .ok_or_else(|| "读取区间超出文件大小。".to_string())?;
        Ok(slice.to_vec())
    } else {
        let mut file = File::open(path).map_err(|error| format!("读取失败：{error}"))?;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| format!("读取失败：{error}"))?;
        let mut buffer = vec![0u8; length];
        file.read_exact(&mut buffer)
            .map_err(|error| format!("读取失败：{error}"))?;
        Ok(buffer)
    }
}

fn line_count_of(offsets: &[u64], size: u64) -> u64 {
    if offsets.is_empty() {
        return 0;
    }
    if size == 0 {
        return 1;
    }
    let last = *offsets.last().expect("non-empty");
    if last == size {
        // File ends with a newline: the empty tail is not a line.
        offsets.len() as u64 - 1
    } else {
        offsets.len() as u64
    }
}

fn build_index(path: &Path, size: u64, mtime: u64) -> Result<IndexEntry, String> {
    let meta = sniff_meta(path)?;
    if meta.charset.starts_with("UTF-16") {
        return Err("大文件只读预览暂不支持 UTF-16 编码".to_string());
    }

    let mut offsets: Vec<u64> = Vec::with_capacity((size / 48).max(1) as usize);
    offsets.push(0);

    let mut reader = BufReader::with_capacity(READ_CHUNK_BYTES, {
        File::open(path).map_err(|error| format!("读取失败：{error}"))?
    });
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    let mut position: u64 = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取失败：{error}"))?;
        if read == 0 {
            break;
        }
        for (index, byte) in buffer[..read].iter().enumerate() {
            if *byte == b'\n' {
                offsets.push(position + index as u64 + 1);
            }
        }
        position += read as u64;
    }

    Ok(IndexEntry {
        size,
        mtime_ms: mtime,
        meta,
        offsets: Arc::new(offsets),
    })
}

/// Detect encoding from the head of the file, cutting at a line boundary so a
/// multi-byte character split by the sniff window cannot fake a lossy file.
fn sniff_meta(path: &Path) -> Result<FileMeta, String> {
    let mut head = Vec::with_capacity(INDEX_SNIFF_BYTES);
    File::open(path)
        .and_then(|file| file.take(INDEX_SNIFF_BYTES as u64).read_to_end(&mut head))
        .map_err(|error| format!("读取失败：{error}"))?;

    if head.iter().take(INDEX_SNIFF_BYTES).any(|byte| *byte == 0)
        && !(head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]))
    {
        return Err("该文件包含二进制内容（NUL 字节），已拒绝以文本方式打开。".to_string());
    }

    if let Some(last_newline) = head.iter().rposition(|byte| *byte == b'\n') {
        head.truncate(last_newline + 1);
    }

    let decoded = codec::decode(&head);
    let mut meta = decoded.meta;
    // The sniff window cannot prove the whole file is lossless.
    meta.lossy = false;
    Ok(meta)
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// `SystemTime` helper kept private; exposed for tests that need a stable mtime.
#[allow(dead_code)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ainative-bigfile-{tag}-{stamp}.txt"))
    }

    #[test]
    fn classifies_by_size() {
        assert_eq!(classify(0), FileLevel::L0);
        assert_eq!(classify(L1_MAX_BYTES), FileLevel::L0);
        assert_eq!(classify(L1_MAX_BYTES + 1), FileLevel::L1);
        assert_eq!(classify(L2_MAX_BYTES), FileLevel::L1);
        assert_eq!(classify(L2_MAX_BYTES + 1), FileLevel::L2);
        assert_eq!(classify(L3_MAX_BYTES), FileLevel::L2);
        assert_eq!(classify(L3_MAX_BYTES + 1), FileLevel::L3);
    }

    #[test]
    fn reads_line_ranges() {
        let path = temp_path("range");
        fs::write(&path, "alpha\r\nbeta\ngamma\r\ndelta").unwrap();
        let cache = LargeFileCache::default();

        let first = cache.read_lines(&path, 0, 2).unwrap();
        assert_eq!(first.start_line, 0);
        assert_eq!(first.lines, vec!["alpha", "beta"]);

        let tail = cache.read_lines(&path, 2, 10).unwrap();
        assert_eq!(tail.start_line, 2);
        assert_eq!(tail.lines, vec!["gamma", "delta"]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reports_line_count_including_unterminated_last_line() {
        let path = temp_path("count");
        fs::write(&path, "a\nb\nc").unwrap();
        let cache = LargeFileCache::default();
        assert_eq!(cache.info(&path).unwrap().line_count, 3);
        let _ = fs::remove_file(path);

        let path = temp_path("count-trailing");
        fs::write(&path, "a\nb\nc\n").unwrap();
        let cache = LargeFileCache::default();
        assert_eq!(cache.info(&path).unwrap().line_count, 3);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn empty_file_has_one_line() {
        let path = temp_path("empty");
        fs::write(&path, "").unwrap();
        let cache = LargeFileCache::default();
        let info = cache.info(&path).unwrap();
        assert_eq!(info.line_count, 1);
        assert_eq!(cache.read_lines(&path, 0, 5).unwrap().lines, vec![""]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_gbk_range_without_mojibake() {
        let path = temp_path("gbk");
        fs::write(&path, [0xD6, 0xD0, 0xCE, 0xC4, b'\n', 0x0A]).unwrap();
        let cache = LargeFileCache::default();
        let info = cache.info(&path).unwrap();
        assert_eq!(info.meta.charset, "GBK");
        let range = cache.read_lines(&path, 0, 1).unwrap();
        assert_eq!(range.lines, vec!["中文"]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_binary_content() {
        let path = temp_path("binary");
        fs::write(&path, [0x4D, 0x5A, 0x00, 0x01]).unwrap();
        let cache = LargeFileCache::default();
        let error = cache.info(&path).unwrap_err();
        assert!(error.contains("二进制"), "unexpected error: {error}");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn read_span_works_with_mmap_and_seek() {
        let path = temp_path("mmap-span");
        fs::write(&path, "hello mmap world").unwrap();
        assert_eq!(read_span(&path, 0, 5, true).unwrap(), b"hello");
        assert_eq!(read_span(&path, 6, 10, false).unwrap(), b"mmap");
        let _ = fs::remove_file(path);
    }

    /// Not part of CI: `cargo test --release --lib perf_memmap -- --ignored --nocapture`
    #[test]
    #[ignore = "performance probe, run manually with --release --ignored --nocapture"]
    fn perf_memmap_reads_120mb_file() {
        use std::time::Instant;

        let line = "2026-10-22T00:00:00Z INFO request served in 12ms path=/api/v1/items\n";
        let target = 120 * 1024 * 1024usize;
        let mut content = String::with_capacity(target + line.len());
        while content.len() < target {
            content.push_str(line);
        }

        let path = temp_path("perf-mmap");
        fs::write(&path, &content).unwrap();
        drop(content);

        let cache = LargeFileCache::default();
        let started = Instant::now();
        let info = cache.info(&path).unwrap();
        println!(
            "index {} MB: {:?} ({} lines)",
            info.size / (1024 * 1024),
            started.elapsed(),
            info.line_count
        );

        let middle = info.line_count / 2;
        let started = Instant::now();
        let range = cache.read_lines(&path, middle, middle + 400).unwrap();
        println!(
            "mmap read_lines 400 lines: {:?} ({} lines)",
            started.elapsed(),
            range.lines.len()
        );
        let _ = fs::remove_file(path);
    }

    /// Not part of CI: `cargo test --release --lib perf_large_file -- --ignored --nocapture`
    #[test]
    #[ignore = "performance probe, run manually with --release --ignored --nocapture"]
    fn perf_large_file_index_and_ranges() {
        use std::time::Instant;

        let line = "2026-10-21T17:00:00Z INFO request served in 12ms path=/api/v1/items\n";
        let mut content = String::with_capacity(L3_MAX_BYTES as usize + line.len());
        while content.len() < L3_MAX_BYTES as usize {
            content.push_str(line);
        }

        let path = temp_path("perf-large");
        fs::write(&path, &content).unwrap();
        drop(content);

        let cache = LargeFileCache::default();
        let start = Instant::now();
        let info = cache.info(&path).unwrap();
        println!(
            "index {} MB: {:?} ({} lines)",
            info.size / (1024 * 1024),
            start.elapsed(),
            info.line_count
        );

        let middle = info.line_count / 2;
        let start = Instant::now();
        let range = cache.read_lines(&path, middle, middle + 400).unwrap();
        println!(
            "uncached read_range 400 lines: {:?} ({} lines)",
            start.elapsed(),
            range.lines.len()
        );

        let start = Instant::now();
        let _ = cache.read_lines(&path, 0, 400).unwrap();
        println!("cached read_range 400 lines: {:?}", start.elapsed());

        let _ = fs::remove_file(path);
    }
}
