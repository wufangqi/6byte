//! External file-change notifications (T13).
//!
//! A single `notify` watcher is created lazily on the first `watch_file` call and
//! watches the *parent directories* of the open files (non-recursively). Watching
//! the directory rather than the file survives the atomic temp+rename saves this
//! editor performs.
//!
//! Events are filtered against the set of watched files and de-duplicated by
//! `(size, mtime)` so the frontend gets at most one event per real change — which
//! also makes the app's own saves a no-op on the UI side (the store already has
//! the new mtime).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

pub type FileChangeSink = Arc<dyn Fn(FileChangeEvent) + Send + Sync + 'static>;

struct Shared {
    watched: Mutex<HashSet<PathBuf>>,
    last_emitted: Mutex<HashMap<PathBuf, (u64, u64)>>,
    sink: FileChangeSink,
}

struct Inner {
    watcher: Option<RecommendedWatcher>,
    dirs: HashMap<PathBuf, usize>,
    shared: Arc<Shared>,
}

/// Keeps one OS watcher per app and a refcounted set of watched directories.
pub struct FileWatcher {
    inner: Mutex<Inner>,
}

impl FileWatcher {
    pub fn new(sink: FileChangeSink) -> Self {
        Self {
            inner: Mutex::new(Inner {
                watcher: None,
                dirs: HashMap::new(),
                shared: Arc::new(Shared {
                    watched: Mutex::new(HashSet::new()),
                    last_emitted: Mutex::new(HashMap::new()),
                    sink,
                }),
            }),
        }
    }

    /// Start watching `path`. `path` must be an absolute path to an existing file.
    pub fn watch(&self, path: &Path) -> Result<(), String> {
        let path = absolute(path)?;
        let parent = path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法监听没有父目录的路径。".to_string())?;

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "监听状态已损坏".to_string())?;
        if inner
            .shared
            .watched
            .lock()
            .map(|set| set.contains(&path))
            .unwrap_or(false)
        {
            return Ok(());
        }

        if inner.watcher.is_none() {
            let shared = Arc::clone(&inner.shared);
            let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
                if let Ok(event) = result {
                    handle_event(&shared, &event);
                }
            })
            .map_err(|error| format!("无法启动文件监听：{error}"))?;
            inner.watcher = Some(watcher);
        }

        let already_watched_dir = inner.dirs.get(&parent).copied().unwrap_or(0) > 0;
        if !already_watched_dir {
            let watcher = inner.watcher.as_mut().expect("watcher created above");
            watcher
                .watch(&parent, RecursiveMode::NonRecursive)
                .map_err(|error| format!("无法监听目录 {}：{error}", parent.display()))?;
        }
        *inner.dirs.entry(parent).or_insert(0) += 1;

        if let Ok(mut set) = inner.shared.watched.lock() {
            set.insert(path);
        }
        Ok(())
    }

    /// Stop watching `path`; the OS watcher is dropped once nothing is watched.
    pub fn unwatch(&self, path: &Path) {
        let Ok(path) = absolute(path) else { return };
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };

        let removed = inner
            .shared
            .watched
            .lock()
            .map(|mut set| set.remove(&path))
            .unwrap_or(false);
        if !removed {
            return;
        }
        if let Ok(mut last) = inner.shared.last_emitted.lock() {
            last.remove(&path);
        }

        if let Some(parent) = path.parent() {
            if let Some(count) = inner.dirs.get_mut(parent) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    inner.dirs.remove(parent);
                    if let Some(watcher) = inner.watcher.as_mut() {
                        let _ = watcher.unwatch(parent);
                    }
                }
            }
        }
        if inner.dirs.is_empty() {
            // Dropping the watcher closes the OS handles.
            inner.watcher = None;
        }
    }
}

fn handle_event(shared: &Shared, event: &Event) {
    let watched = match shared.watched.lock() {
        Ok(watched) => watched,
        Err(_) => return,
    };

    for path in &event.paths {
        if !watched.contains(path) {
            continue;
        }
        let signature = match fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => (metadata.len(), mtime_ms(path)),
            // Deleted or unreadable: pin to (0, 0) so the frontend can report it.
            _ => (0, 0),
        };

        let mut last = match shared.last_emitted.lock() {
            Ok(last) => last,
            Err(_) => return,
        };
        if last.get(path) == Some(&signature) {
            continue;
        }
        last.insert(path.clone(), signature);

        (shared.sink)(FileChangeEvent {
            path: path.to_string_lossy().to_string(),
            size: signature.0,
            mtime_ms: signature.1,
        });
    }
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| format!("无法解析路径：{error}"))
    }
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ainative-watch-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn emits_an_event_when_a_watched_file_changes() {
        let dir = temp_dir("change");
        let file = dir.join("notes.txt");
        fs::write(&file, "first").unwrap();

        let (sender, receiver) = mpsc::channel();
        let watcher = FileWatcher::new(Arc::new(move |event| {
            let _ = sender.send(event);
        }));
        watcher.watch(&file).unwrap();

        // Give the OS watcher a moment to register before touching the file.
        std::thread::sleep(Duration::from_millis(500));

        // Some backends report a transient truncate event (size 0) before the
        // real write, and macOS coalesces events; retry writes until a content
        // event arrives instead of depending on a single OS notification.
        let mut received = None;
        for attempt in 0..6 {
            fs::write(&file, format!("second version {attempt}")).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(event) if event.size > 0 => {
                        received = Some(event);
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            if received.is_some() {
                break;
            }
        }

        let event = received.expect("expected a file change event with content");
        // macOS reports canonicalised paths (/private/var vs /var), so compare
        // the file name rather than the whole path.
        assert!(
            event.path.ends_with("notes.txt"),
            "unexpected path: {}",
            event.path
        );
        assert!(event.mtime_ms > 0);

        watcher.unwatch(&file);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ignores_files_that_are_not_watched() {
        let dir = temp_dir("ignored");
        let watched_file = dir.join("watched.txt");
        let other_file = dir.join("other.txt");
        fs::write(&watched_file, "a").unwrap();
        fs::write(&other_file, "b").unwrap();

        let (sender, receiver) = mpsc::channel();
        let watcher = FileWatcher::new(Arc::new(move |event| {
            let _ = sender.send(event);
        }));
        watcher.watch(&watched_file).unwrap();
        std::thread::sleep(Duration::from_millis(250));

        fs::write(&other_file, "changed").unwrap();
        let deadline = Instant::now() + Duration::from_millis(1200);
        while Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(Duration::from_millis(100)) {
                panic!("unexpected event for {}", event.path);
            }
        }

        watcher.unwatch(&watched_file);
        let _ = fs::remove_dir_all(dir);
    }
}
