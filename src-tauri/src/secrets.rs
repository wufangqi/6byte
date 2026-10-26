//! API keys for OpenAI-compatible models. Each model profile has its own
//! keychain account. The secret never goes into a config file the editor writes.

#[cfg(test)]
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(test)]
use std::sync::{Mutex, MutexGuard};

const SERVICE: &str = "dev.aneditor.app";
const ACCOUNT: &str = "openai-compatible";

pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// `None` and `"default"` keep the original single-key account so an existing
/// install still finds its key. Other ids get their own account.
///
/// The separator is a hyphen. Windows Credential Manager will accept a colon
/// in the target name and then fail to read that credential back.
fn account_name(profile_id: Option<&str>) -> Result<String, String> {
    let Some(id) = profile_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(ACCOUNT.to_string());
    };
    if id == "default" {
        return Ok(ACCOUNT.to_string());
    }
    let safe = id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if !safe {
        return Err("模型标识无效。".to_string());
    }
    Ok(format!("{ACCOUNT}-{id}"))
}

fn host_account(profile_id: Option<&str>) -> Result<String, String> {
    Ok(format!("{}-host", account_name(profile_id)?))
}

/// OS credential store. A missing entry is "no key", not an error.
pub struct SystemKeyring;

impl SecretStore for SystemKeyring {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keyring_error)?;
        entry.set_password(secret).map_err(keyring_error)
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keyring_error)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keyring_error(error)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keyring_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keyring_error(error)),
        }
    }
}

fn keyring_error(error: keyring::Error) -> String {
    format!("钥匙串操作失败：{error}")
}

#[cfg(test)]
#[derive(Default)]
struct MemoryStore {
    values: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        lock(&self.values).insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(lock(&self.values).get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        lock(&self.values).remove(account);
        Ok(())
    }
}

#[cfg(test)]
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Keychain slots addressed by model profile id.
#[derive(Clone)]
pub struct AiSecrets {
    store: Arc<dyn SecretStore>,
}

impl AiSecrets {
    pub fn system() -> Self {
        Self {
            store: Arc::new(SystemKeyring),
        }
    }

    pub fn set(&self, profile_id: Option<&str>, secret: &str) -> Result<(), String> {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            return Err("密钥不能为空。".to_string());
        }
        self.store.set(&account_name(profile_id)?, trimmed)
    }

    pub fn get(&self, profile_id: Option<&str>) -> Result<Option<String>, String> {
        self.store.get(&account_name(profile_id)?)
    }

    /// Store the key and the origin it may be sent to. A later request to
    /// another origin does not receive this key.
    pub fn set_bound(
        &self,
        profile_id: Option<&str>,
        secret: &str,
        origin: &str,
    ) -> Result<(), String> {
        let origin = origin.trim();
        if origin.is_empty() {
            return Err("服务地址无效。".to_string());
        }
        self.set(profile_id, secret)?;
        self.store.set(&host_account(profile_id)?, origin)
    }

    pub fn bound_origin(&self, profile_id: Option<&str>) -> Result<Option<String>, String> {
        self.store.get(&host_account(profile_id)?)
    }

    pub fn delete(&self, profile_id: Option<&str>) -> Result<(), String> {
        self.store.delete(&account_name(profile_id)?)?;
        self.store.delete(&host_account(profile_id)?)
    }

    #[cfg(test)]
    pub(crate) fn memory() -> Self {
        Self {
            store: Arc::new(MemoryStore::default()),
        }
    }
}

/// Explicit key wins. Otherwise use the stored one. A store failure is not hidden.
pub fn resolve_key(
    explicit: Option<String>,
    stored: Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    if let Some(key) = explicit {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    stored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_delete_is_idempotent() {
        let secrets = AiSecrets::memory();
        assert_eq!(secrets.get(None).unwrap(), None);
        secrets.set(None, "  sk-test  ").unwrap();
        assert_eq!(secrets.get(None).unwrap().as_deref(), Some("sk-test"));
        secrets.set(Some("default"), "sk-next").unwrap();
        assert_eq!(secrets.get(None).unwrap().as_deref(), Some("sk-next"));
        secrets.set(Some("mcloud"), "sk-cloud").unwrap();
        assert_eq!(
            secrets.get(Some("mcloud")).unwrap().as_deref(),
            Some("sk-cloud")
        );
        assert_eq!(secrets.get(None).unwrap().as_deref(), Some("sk-next"));
        secrets.delete(Some("mcloud")).unwrap();
        secrets.delete(Some("mcloud")).unwrap();
        assert_eq!(secrets.get(Some("mcloud")).unwrap(), None);
        assert_eq!(secrets.get(None).unwrap().as_deref(), Some("sk-next"));
    }

    #[test]
    fn empty_key_is_rejected_before_it_is_stored() {
        let secrets = AiSecrets::memory();
        assert_eq!(secrets.set(None, "   ").unwrap_err(), "密钥不能为空。");
        assert_eq!(secrets.get(None).unwrap(), None);
        assert_eq!(
            secrets.set(Some("../x"), "sk").unwrap_err(),
            "模型标识无效。"
        );
    }

    /// The real OS store must survive creating a second entry. The mock store
    /// keeps each entry in its own memory, so a saved key disappears on the next read.
    #[cfg(windows)]
    #[test]
    fn system_keyring_round_trip() {
        let secrets = AiSecrets::system();
        let id = "mkeyringtest01";
        let _ = secrets.delete(Some(id));
        secrets.set(Some(id), "sk-roundtrip").expect("set");
        let got = secrets.get(Some(id)).expect("get");
        let _ = secrets.delete(Some(id));
        assert_eq!(got.as_deref(), Some("sk-roundtrip"));
    }

    #[test]
    fn explicit_key_beats_the_stored_one_and_blanks_fall_through() {
        assert_eq!(
            resolve_key(Some("  typed  ".into()), Ok(Some("stored".into()))).unwrap(),
            Some("typed".into())
        );
        assert_eq!(
            resolve_key(Some("  ".into()), Ok(Some("stored".into()))).unwrap(),
            Some("stored".into())
        );
        assert_eq!(resolve_key(None, Ok(None)).unwrap(), None);
        assert!(resolve_key(None, Err("钥匙串操作失败：down".into())).is_err());
    }
}
