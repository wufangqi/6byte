//! Trust-on-first-use host key storage. The file is `<app_config_dir>/ssh_known_hosts.json`
//! and keyed by lowercase `host:port`. A fingerprint mismatch on reconnect refuses the
//! connection and emits `ssh-hostkey-mismatch`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint_sha256: String,
    pub public_key_blob: Vec<u8>,
    pub first_seen: u64,
}

fn host_key(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_lowercase())
}

/// Compute the SHA-256 fingerprint of a raw public key blob, base64-encoded without padding.
pub fn fingerprint(blob: &[u8]) -> String {
    let digest = Sha256::digest(blob);
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
}

pub struct KnownHostsStore {
    path: PathBuf,
    entries: RwLock<Vec<KnownHostEntry>>,
}

impl KnownHostsStore {
    pub fn new(path: PathBuf) -> Self {
        let entries = load(&path).unwrap_or_default();
        Self {
            path,
            entries: RwLock::new(entries),
        }
    }

    /// Record a host key on first connect. Returns Ok(()) even if the entry already exists
    /// with the same fingerprint (idempotent).
    pub fn trust(&self, host: &str, port: u16, key_type: &str, blob: &[u8]) -> Result<(), String> {
        let key = host_key(host, port);
        let fp = fingerprint(blob);
        let mut guard = self.lock_write()?;
        if let Some(entry) = guard
            .iter_mut()
            .find(|entry| host_key(&entry.host, entry.port) == key)
        {
            if entry.fingerprint_sha256 == fp {
                return Ok(());
            }
            // Fingerprint changed between calls inside the same session — treat as mismatch.
            return Err(format!(
                "主机密钥已更改（{host}:{port}），已拒绝连接。若确认服务器已重装，请清除该主机记录后重试。"
            ));
        }
        guard.push(KnownHostEntry {
            host: host.to_lowercase(),
            port,
            key_type: key_type.to_string(),
            fingerprint_sha256: fp,
            public_key_blob: blob.to_vec(),
            first_seen: now_ms(),
        });
        persist(&self.path, &guard)
    }

    /// Verify a host key against the stored fingerprint. Returns Ok(()) on match or when no
    /// record exists yet (caller should then call `trust`). On mismatch returns the error
    /// message required by the contract plus the expected/actual fingerprints for the event.
    pub fn verify(&self, host: &str, port: u16, blob: &[u8]) -> Result<(), HostKeyMismatch> {
        let key = host_key(host, port);
        let actual = fingerprint(blob);
        let guard = match self.lock_read() {
            Ok(g) => g,
            Err(_) => {
                // Lock poisoned — treat as no record so the caller can still connect.
                return Ok(());
            }
        };
        let Some(entry) = guard
            .iter()
            .find(|entry| host_key(&entry.host, entry.port) == key)
        else {
            return Ok(());
        };
        if entry.fingerprint_sha256 == actual {
            return Ok(());
        }
        Err(HostKeyMismatch {
            host: host.to_lowercase(),
            port,
            expected: entry.fingerprint_sha256.clone(),
            actual,
        })
    }

    /// Remove a host record (used by `ssh_forget_host`).
    pub fn forget(&self, host: &str, port: u16) -> Result<(), String> {
        let key = host_key(host, port);
        let mut guard = self.lock_write()?;
        guard.retain(|entry| host_key(&entry.host, entry.port) != key);
        persist(&self.path, &guard)
    }

    fn lock_read(&self) -> Result<std::sync::RwLockReadGuard<'_, Vec<KnownHostEntry>>, String> {
        self.entries
            .read()
            .map_err(|_| "读取已知主机失败：锁中毒。".to_string())
    }

    fn lock_write(&self) -> Result<std::sync::RwLockWriteGuard<'_, Vec<KnownHostEntry>>, String> {
        self.entries
            .write()
            .map_err(|_| "写入已知主机失败：锁中毒。".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct HostKeyMismatch {
    pub host: String,
    pub port: u16,
    pub expected: String,
    pub actual: String,
}

impl HostKeyMismatch {
    #[allow(dead_code)]
    pub fn message(&self) -> String {
        format!(
            "主机密钥已更改（{}:{}），已拒绝连接。若确认服务器已重装，请清除该主机记录后重试。",
            self.host, self.port
        )
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn load(path: &Path) -> Result<Vec<KnownHostEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("读取已知主机失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("已知主机文件损坏：{error}"))
}

fn persist(path: &Path, entries: &[KnownHostEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let json = serde_json::to_string_pretty(entries)
        .map_err(|error| format!("序列化已知主机失败：{error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{stamp}.tmp"));
    let mut file = fs::File::create(&tmp).map_err(|error| format!("写入已知主机失败：{error}"))?;
    file.write_all(json.as_bytes())
        .map_err(|error| format!("写入已知主机失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("写入已知主机失败：{error}"))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|error| format!("写入已知主机失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_store(tag: &str) -> KnownHostsStore {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ainative-ssh-kh-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        KnownHostsStore::new(dir.join("known_hosts.json"))
    }

    #[test]
    fn first_connect_trusts_and_records_fingerprint() {
        let store = temp_store("first");
        let blob = b"ssh-ed25519-blob-example";
        store.trust("Example.COM", 22, "ssh-ed25519", blob).unwrap();
        assert!(store.verify("example.com", 22, blob).is_ok());
    }

    #[test]
    fn matching_fingerprint_passes_verification() {
        let store = temp_store("match");
        let blob = b"same-key";
        store.trust("host", 2222, "ssh-rsa", blob).unwrap();
        assert!(store.verify("HOST", 2222, blob).is_ok());
    }

    #[test]
    fn mismatched_fingerprint_is_rejected_with_expected_and_actual() {
        let store = temp_store("mismatch");
        let original = b"original-key";
        let replaced = b"replaced-key";
        store.trust("srv", 22, "ssh-ed25519", original).unwrap();
        let err = store.verify("srv", 22, replaced).unwrap_err();
        assert_eq!(err.host, "srv");
        assert_eq!(err.port, 22);
        assert_eq!(err.expected, fingerprint(original));
        assert_eq!(err.actual, fingerprint(replaced));
        assert!(err.message().contains("主机密钥已更改"));
    }

    #[test]
    fn forget_removes_the_record_so_next_connect_can_trust_again() {
        let store = temp_store("forget");
        let blob = b"key";
        store.trust("h", 22, "t", blob).unwrap();
        store.forget("H", 22).unwrap();
        // After forgetting, verification passes because there is no record.
        assert!(store.verify("h", 22, b"other").is_ok());
    }

    #[test]
    fn fingerprint_is_sha256_base64_no_padding() {
        let blob = b"test-blob";
        let fp = fingerprint(blob);
        let digest = Sha256::digest(blob);
        let expected = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
        assert_eq!(fp, expected);
        assert!(!fp.ends_with('='));
    }
}
