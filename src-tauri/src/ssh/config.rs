//! SSH profile persistence. Profiles live in `<app_config_dir>/ssh_profiles.json`
//! and are written atomically (temp file + rename). Secrets never touch this file;
//! they go through `secrets::SecretStore`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub remember_secret: bool,
}

fn default_port() -> u16 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfileInfo {
    #[serde(flatten)]
    pub profile: SshProfile,
    pub has_password: bool,
    pub has_passphrase: bool,
}

impl SshProfile {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("SSH 配置无效：名称不能为空。".into());
        }
        if self.host.trim().is_empty() {
            return Err("SSH 配置无效：主机不能为空。".into());
        }
        if self.username.trim().is_empty() {
            return Err("SSH 配置无效：用户名不能为空。".into());
        }
        if self.port == 0 {
            return Err("SSH 配置无效：端口不能为 0。".into());
        }
        if matches!(self.auth, SshAuth::Key) && self.key_path.trim().is_empty() {
            return Err("SSH 配置无效：使用密钥认证时必须指定私钥路径。".into());
        }
        Ok(())
    }
}

/// Thread-safe store backed by a JSON file. Reads are cached; writes flush to disk.
pub struct SshProfileStore {
    path: PathBuf,
    cache: RwLock<Vec<SshProfile>>,
}

impl SshProfileStore {
    pub fn new(path: PathBuf) -> Self {
        let profiles = load_from_disk(&path).unwrap_or_default();
        Self {
            path,
            cache: RwLock::new(profiles),
        }
    }

    pub fn list(&self) -> Vec<SshProfile> {
        self.cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn get(&self, id: &str) -> Option<SshProfile> {
        self.list().into_iter().find(|profile| profile.id == id)
    }

    /// Insert or update a profile. An empty `profile.id` means "create new" and
    /// the backend assigns a uuid v4. Returns the persisted profile.
    pub fn save(&self, mut profile: SshProfile) -> Result<SshProfile, String> {
        profile.validate()?;
        if profile.id.trim().is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        let mut guard = self
            .cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(slot) = guard.iter_mut().find(|existing| existing.id == profile.id) {
            *slot = profile.clone();
        } else {
            guard.push(profile.clone());
        }
        persist(&self.path, &guard)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut guard = self
            .cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = guard.len();
        guard.retain(|profile| profile.id != id);
        if guard.len() == before {
            return Err("SSH 配置不存在。".into());
        }
        persist(&self.path, &guard)
    }
}

fn load_from_disk(path: &Path) -> Result<Vec<SshProfile>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("读取 SSH 配置失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("SSH 配置文件损坏：{error}"))
}

fn persist(path: &Path, profiles: &[SshProfile]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let json = serde_json::to_string_pretty(profiles)
        .map_err(|error| format!("序列化 SSH 配置失败：{error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{stamp}.tmp"));
    let mut file = fs::File::create(&tmp).map_err(|error| format!("写入 SSH 配置失败：{error}"))?;
    file.write_all(json.as_bytes())
        .map_err(|error| format!("写入 SSH 配置失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("写入 SSH 配置失败：{error}"))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|error| format!("写入 SSH 配置失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_store(tag: &str) -> SshProfileStore {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ainative-ssh-cfg-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        SshProfileStore::new(dir.join("profiles.json"))
    }

    fn sample_profile(id: &str) -> SshProfile {
        SshProfile {
            id: id.to_string(),
            name: "dev".into(),
            host: "example.com".into(),
            port: 22,
            username: "alice".into(),
            auth: SshAuth::Password,
            key_path: String::new(),
            remember_secret: false,
        }
    }

    #[test]
    fn save_creates_new_profile_when_id_is_empty() {
        let store = temp_store("create");
        let mut profile = sample_profile("");
        profile.name = "new".into();
        let saved = store.save(profile).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn save_updates_existing_profile_by_id() {
        let store = temp_store("update");
        let first = store.save(sample_profile("")).unwrap();
        let mut updated = first.clone();
        updated.name = "renamed".into();
        let second = store.save(updated).unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].name, "renamed");
    }

    #[test]
    fn delete_removes_profile_and_errors_on_missing() {
        let store = temp_store("delete");
        let saved = store.save(sample_profile("")).unwrap();
        store.delete(&saved.id).unwrap();
        assert!(store.list().is_empty());
        assert_eq!(store.delete("nope").unwrap_err(), "SSH 配置不存在。");
    }

    #[test]
    fn validation_rejects_blank_fields_and_key_without_path() {
        let mut profile = sample_profile("x");
        profile.name = "".into();
        assert!(profile.validate().is_err());
        profile.name = "ok".into();
        profile.host = "".into();
        assert!(profile.validate().is_err());
        profile.host = "h".into();
        profile.username = "".into();
        assert!(profile.validate().is_err());
        profile.username = "u".into();
        profile.port = 0;
        assert!(profile.validate().is_err());
        profile.port = 22;
        profile.auth = SshAuth::Key;
        assert!(profile.validate().is_err());
        profile.key_path = "/tmp/id_ed25519".into();
        assert!(profile.validate().is_ok());
    }
}
