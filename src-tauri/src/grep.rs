//! Cross-file grep (T14).
//!
//! Scans a directory tree with `regex`, skipping VCS/依赖 directories, binary
//! files (NUL bytes) and oversized files, and returns at most `max_results`
//! matches so one query cannot flood the UI.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use regex::RegexBuilder;
use serde::Serialize;

pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES_SCANNED: usize = 20_000;
const MAX_DEPTH: usize = 16;
const DEFAULT_MAX_RESULTS: usize = 2_000;
const SNIPPET_CHARS: usize = 240;

const SKIP_DIRS: [&str; 8] = [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "dist",
    ".next",
    "vendor",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    pub line: u32,
    /// 1-based character column of the first match within the line.
    pub column: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResponse {
    pub matches: Vec<GrepMatch>,
    pub files_scanned: u32,
    pub files_matched: u32,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// Search `root` recursively for `pattern` (Rust regex syntax).
pub fn grep(
    root: &Path,
    pattern: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
) -> Result<GrepResponse, String> {
    if pattern.trim().is_empty() {
        return Err("搜索内容不能为空。".to_string());
    }
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("正则表达式无效：{error}"))?;
    if !root.is_dir() {
        return Err("搜索目录不存在或不是文件夹。".to_string());
    }

    let started = Instant::now();
    let limit = max_results.unwrap_or(DEFAULT_MAX_RESULTS).max(1);
    let mut matches = Vec::new();
    let mut files_scanned: u32 = 0;
    let mut files_matched: u32 = 0;
    let mut truncated = false;

    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    'walk: while let Some((dir, depth)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };

            if file_type.is_dir() {
                if depth >= MAX_DEPTH {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            if files_scanned as usize >= MAX_FILES_SCANNED {
                truncated = true;
                break 'walk;
            }
            files_scanned += 1;

            if fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_FILE_BYTES {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if looks_binary(&bytes) {
                continue;
            }

            let text = String::from_utf8_lossy(&bytes);
            let mut file_matched = false;
            for (index, line) in text.lines().enumerate() {
                let Some(found) = regex.find(line) else {
                    continue;
                };
                if matches.len() >= limit {
                    truncated = true;
                    break 'walk;
                }
                let column = line[..found.start()].chars().count() as u32 + 1;
                matches.push(GrepMatch {
                    path: path.to_string_lossy().to_string(),
                    line: index as u32 + 1,
                    column,
                    text: snippet(line),
                });
                file_matched = true;
            }
            if file_matched {
                files_matched += 1;
            }
        }
    }

    Ok(GrepResponse {
        matches,
        files_scanned,
        files_matched,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn looks_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8 * 1024)];
    head.contains(&0)
}

fn snippet(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.chars().count() <= SNIPPET_CHARS {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(SNIPPET_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ainative-grep-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_matches_with_line_and_column() {
        let dir = temp_dir("basic");
        fs::write(dir.join("a.md"), "first line\nhello world\nlast\n").unwrap();
        fs::write(dir.join("b.txt"), "nothing here\n").unwrap();

        let result = grep(&dir, "hello", false, None).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line, 2);
        assert_eq!(result.matches[0].column, 1);
        assert_eq!(result.files_matched, 1);
        assert_eq!(result.matches[0].text, "hello world");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn honours_case_sensitivity() {
        let dir = temp_dir("case");
        fs::write(dir.join("a.txt"), "Hello\nhello\nHELLO\n").unwrap();

        let insensitive = grep(&dir, "hello", false, None).unwrap();
        assert_eq!(insensitive.matches.len(), 3);

        let sensitive = grep(&dir, "hello", true, None).unwrap();
        assert_eq!(sensitive.matches.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn supports_regular_expressions() {
        let dir = temp_dir("regex");
        fs::write(dir.join("a.txt"), "item-42\nitem-7\nother\n").unwrap();
        let result = grep(&dir, r"item-\d+", false, None).unwrap();
        assert_eq!(result.matches.len(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn skips_binary_and_hidden_directories() {
        let dir = temp_dir("skip");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/secret.txt"), "needle").unwrap();
        fs::write(dir.join("blob.bin"), [0x00, 0x01, 0x02, 0x6E]).unwrap();
        fs::write(dir.join("notes.txt"), "needle in text").unwrap();

        let result = grep(&dir, "needle", false, None).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert!(result.matches[0].path.ends_with("notes.txt"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reports_truncation_when_the_limit_is_hit() {
        let dir = temp_dir("limit");
        let content = "hit\n".repeat(50);
        fs::write(dir.join("a.txt"), content).unwrap();

        let result = grep(&dir, "hit", false, Some(5)).unwrap();
        assert_eq!(result.matches.len(), 5);
        assert!(result.truncated);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_an_invalid_pattern() {
        let dir = temp_dir("invalid");
        fs::write(dir.join("a.txt"), "x").unwrap();
        let error = grep(&dir, "(", false, None).unwrap_err();
        assert!(
            error.contains("正则表达式无效"),
            "unexpected error: {error}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_an_empty_pattern() {
        let dir = temp_dir("empty-pattern");
        let error = grep(&dir, "   ", false, None).unwrap_err();
        assert!(error.contains("不能为空"), "unexpected error: {error}");
        let _ = fs::remove_dir_all(dir);
    }

    /// Not part of CI: `cargo test --release --lib perf_grep -- --ignored --nocapture`
    #[test]
    #[ignore = "performance probe, run manually with --release --ignored --nocapture"]
    fn perf_grep_scans_1000_files() {
        let dir = temp_dir("perf");
        for index in 0..1_000 {
            let path = dir.join(format!("file-{index}.log"));
            let content = format!(
                "2026-10-21T18:00:00Z INFO request served in 12ms path=/api/v1/items/{index}\n"
            )
            .repeat(20);
            fs::write(path, content).unwrap();
        }

        let started = Instant::now();
        let result = grep(&dir, "items/500", false, None).unwrap();
        println!(
            "grep 1000 files: {:?} ({} files scanned, {} matches, truncated={})",
            started.elapsed(),
            result.files_scanned,
            result.matches.len(),
            result.truncated
        );
        assert_eq!(result.matches.len(), 20);
        let _ = fs::remove_dir_all(dir);
    }
}
