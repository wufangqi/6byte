//! SSH remote functionality: profiles, sessions, SFTP file operations and port forwarding.

pub mod commands;
pub mod config;
pub mod files;
pub mod forward;
pub mod known_hosts;
pub mod session;

use std::sync::Arc;

use dashmap::DashMap;
use tauri::{AppHandle, Emitter, Manager};
use tokio::runtime::Runtime as TokioRuntime;

use self::config::{SshProfile, SshProfileStore};
use self::forward::ForwardRegistry;
use self::known_hosts::{HostKeyMismatch, KnownHostsStore};
use self::session::SessionHandle;

/// Bridge to the OS keyring for SSH credentials. Mirrors `AiSecrets` but uses
/// account names `ssh-<id>` and `ssh-<id>-passphrase`.
pub(crate) struct SshSecrets {
    store: std::sync::Arc<dyn crate::secrets::SecretStore>,
}

impl SshSecrets {
    fn system() -> Self {
        Self {
            store: std::sync::Arc::new(crate::secrets::SystemKeyring),
        }
    }

    fn validate_id(id: &str) -> Result<(), String> {
        let safe = !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
        if !safe {
            return Err("SSH 配置无效：标识符无效。".into());
        }
        Ok(())
    }

    fn password_account(id: &str) -> Result<String, String> {
        Self::validate_id(id)?;
        Ok(format!("ssh-{id}"))
    }

    fn passphrase_account(id: &str) -> Result<String, String> {
        Self::validate_id(id)?;
        Ok(format!("ssh-{id}-passphrase"))
    }

    pub fn set_password(&self, id: &str, secret: &str) -> Result<(), String> {
        self.store.set(&Self::password_account(id)?, secret)
    }

    pub fn get_password(&self, id: &str) -> Result<Option<String>, String> {
        self.store.get(&Self::password_account(id)?)
    }

    pub fn set_passphrase(&self, id: &str, secret: &str) -> Result<(), String> {
        self.store.set(&Self::passphrase_account(id)?, secret)
    }

    pub fn get_passphrase(&self, id: &str) -> Result<Option<String>, String> {
        self.store.get(&Self::passphrase_account(id)?)
    }

    pub fn has_password(&self, id: &str) -> Result<bool, String> {
        Ok(self.get_password(id)?.is_some())
    }

    pub fn has_passphrase(&self, id: &str) -> Result<bool, String> {
        Ok(self.get_passphrase(id)?.is_some())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _ = self.store.delete(&Self::password_account(id)?);
        let _ = self.store.delete(&Self::passphrase_account(id)?);
        Ok(())
    }
}

pub(crate) fn secrets_bridge() -> SshSecrets {
    SshSecrets::system()
}

/// Central SSH state managed by Tauri. Holds a dedicated tokio runtime (so the
/// async SSH stack never blocks the Tauri command thread), the profile/known-hosts
/// stores, live sessions and active forwards.
pub struct SshHub {
    pub(crate) handle: AppHandle,
    pub(crate) runtime: Arc<TokioRuntime>,
    pub(crate) profiles: SshProfileStore,
    pub(crate) known_hosts: Arc<KnownHostsStore>,
    pub(crate) sessions: DashMap<String, SessionHandle>,
    pub(crate) forwards: Arc<ForwardRegistry>,
}

impl SshHub {
    pub fn new(handle: AppHandle) -> Self {
        let runtime = Arc::new(TokioRuntime::new().expect("failed to build SSH tokio runtime"));
        let config_dir = handle.path().app_config_dir().expect("app config dir");
        let profiles = SshProfileStore::new(config_dir.join("ssh_profiles.json"));
        let known_hosts = Arc::new(KnownHostsStore::new(
            config_dir.join("ssh_known_hosts.json"),
        ));
        Self {
            handle,
            runtime,
            profiles,
            known_hosts,
            sessions: DashMap::new(),
            forwards: Arc::new(ForwardRegistry::default()),
        }
    }

    pub(crate) fn emit_session(&self, info: &session::SshSessionInfo) {
        let _ = self.handle.emit("ssh-session", info);
    }

    /// Emit `ssh-hostkey-mismatch` when the handshake rejected the server key.
    pub(crate) fn emit_host_key_mismatch_if_any(
        &self,
        profile: &SshProfile,
        slot: &std::sync::Mutex<Option<HostKeyMismatch>>,
    ) {
        let mismatch = slot.lock().ok().and_then(|guard| guard.clone());
        if let Some(mismatch) = mismatch {
            self.emit_hostkey_mismatch(
                &profile.id,
                &mismatch.host,
                mismatch.port,
                &mismatch.expected,
                &mismatch.actual,
            );
        }
    }

    pub(crate) fn emit_hostkey_mismatch(
        &self,
        profile_id: &str,
        host: &str,
        port: u16,
        expected: &str,
        actual: &str,
    ) {
        let _ = self.handle.emit(
            "ssh-hostkey-mismatch",
            serde_json::json!({
                "profileId": profile_id,
                "host": host,
                "port": port,
                "expected": expected,
                "actual": actual,
            }),
        );
    }

    pub(crate) fn emit_forward_update(&self, profile_id: &str, forwards: &[forward::ForwardInfo]) {
        let _ = self.handle.emit(
            "ssh-forward-update",
            serde_json::json!({
                "profileId": profile_id,
                "forwards": forwards,
            }),
        );
    }
}
