//! One directory level for the workspace tree. Never recursive.

use std::fs;
use std::io::{Error, ErrorKind};
use std::path::PathBuf;

use serde::Serialize;

use crate::skip::is_skipped_dir;

pub const LIST_LIMIT: usize = 2_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirList {
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
    pub limit: usize,
}

fn io_error(error: Error) -> String {
    match error.kind() {
        ErrorKind::PermissionDenied => "没有权限。".to_string(),
        ErrorKind::NotFound => "读取失败：路径不存在。".to_string(),
        _ => format!("读取失败：{error}"),
    }
}

/// `canonicalize` yields a verbatim path on Windows (`\\?\C:\...`). Keep those
/// for filesystem calls but hand readable paths back to the UI, so tabs,
/// session and recent-file comparisons keep working.
fn strip_verbatim(path: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// List the immediate children of `path`. Hidden names, skipped directories,
/// and symlinks are omitted. At most [`LIST_LIMIT`] entries are returned.
#[tauri::command]
pub fn list_dir_children(path: String) -> Result<DirList, String> {
    let canonical = PathBuf::from(&path).canonicalize().map_err(io_error)?;
    if !canonical.is_dir() {
        return Err("不是文件夹。".to_string());
    }
    let display_base = strip_verbatim(&canonical);
    let read = fs::read_dir(&canonical).map_err(io_error)?;
    let mut entries = Vec::new();
    for entry in read {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() || name.starts_with('.') || is_skipped_dir(&name) {
            continue;
        }
        let kind = if file_type.is_dir() {
            "dir"
        } else if file_type.is_file() {
            "file"
        } else {
            continue;
        };
        let child_path = display_base.join(&name);
        let Some(child) = child_path.to_str() else {
            continue;
        };
        entries.push(DirEntryInfo {
            name,
            path: child.to_string(),
            kind: kind.to_string(),
        });
    }
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    let truncated = entries.len() > LIST_LIMIT;
    entries.truncate(LIST_LIMIT);
    Ok(DirList {
        entries,
        truncated,
        limit: LIST_LIMIT,
    })
}

/// Show `path` in the system file manager. The tree stays read-only.
#[tauri::command]
pub fn reveal_in_os(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("读取失败：路径不存在。".to_string());
    }
    spawn_reveal(&target).map_err(io_error)?;
    Ok(())
}

fn spawn_reveal(target: &std::path::Path) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        let path = target.to_string_lossy();
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .spawn()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = target.parent().unwrap_or(target);
        std::process::Command::new("xdg-open").arg(parent).spawn()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ainative-tree-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_one_level_and_skips_hidden_and_ignored_dirs() {
        let dir = temp_dir("level");
        fs::write(dir.join("notes.md"), "hi").unwrap();
        fs::write(dir.join("shot.png"), [1u8, 2]).unwrap();
        fs::write(dir.join(".env"), "secret").unwrap();
        fs::create_dir(dir.join("nested")).unwrap();
        fs::write(dir.join("nested").join("inner.txt"), "x").unwrap();
        fs::create_dir(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules").join("pkg.js"), "no").unwrap();
        fs::create_dir(dir.join(".git")).unwrap();

        let listed = list_dir_children(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = listed
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["nested", "notes.md", "shot.png"]);
        assert!(listed
            .entries
            .iter()
            .any(|entry| entry.name == "nested" && entry.kind == "dir"));
        assert!(listed
            .entries
            .iter()
            .all(|entry| !entry.path.replace('\\', "/").contains("/nested/")));
        assert!(!listed.truncated);
        assert!(
            listed
                .entries
                .iter()
                .all(|entry| !entry.path.contains("\\\\?\\")),
            "child paths must stay readable for the UI: {:?}",
            listed.entries
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn strips_windows_verbatim_prefixes() {
        let plain = strip_verbatim(std::path::Path::new("/tmp/x"));
        assert_eq!(plain, PathBuf::from("/tmp/x"));
        #[cfg(windows)]
        {
            assert_eq!(
                strip_verbatim(std::path::Path::new(r"\\?\C:\docs\x")),
                PathBuf::from(r"C:\docs\x")
            );
            assert_eq!(
                strip_verbatim(std::path::Path::new(r"\\?\UNC\srv\share\x")),
                PathBuf::from(r"\\srv\share\x")
            );
        }
    }

    #[test]
    fn truncates_a_directory_at_the_limit() {
        let dir = temp_dir("cap");
        for index in 0..=LIST_LIMIT {
            fs::write(dir.join(format!("f{index:04}.txt")), "x").unwrap();
        }
        let listed = list_dir_children(dir.to_string_lossy().to_string()).unwrap();
        assert!(listed.truncated);
        assert_eq!(listed.entries.len(), LIST_LIMIT);
        assert_eq!(listed.limit, LIST_LIMIT);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_a_file_and_a_missing_path() {
        let dir = temp_dir("bad");
        let file = dir.join("note.txt");
        fs::write(&file, "hi").unwrap();
        let error = list_dir_children(file.to_string_lossy().to_string()).unwrap_err();
        assert_eq!(error, "不是文件夹。");
        let missing = dir.join("nope");
        let error = list_dir_children(missing.to_string_lossy().to_string()).unwrap_err();
        assert!(error.starts_with("读取失败："), "{error}");
        let error = io_error(Error::new(ErrorKind::PermissionDenied, "denied"));
        assert_eq!(error, "没有权限。");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn skips_a_symlink() {
        let dir = temp_dir("link");
        let real = dir.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("inside.txt"), "x").unwrap();
        let link = dir.join("link");
        let created = symlink_dir(&real, &link);
        if created.is_err() {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let listed = list_dir_children(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = listed
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["real"]);
        let _ = fs::remove_dir_all(dir);
    }

    fn symlink_dir(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
    }
}
