//! SSH session lifecycle: connect, authenticate (password / publickey / agent),
//! keepalive, disconnect and the `ssh-session` event broadcast.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, DisconnectReason};
use russh::keys::PublicKeyBase64;
use russh::{ChannelId, ChannelMsg, Error as RusshError};
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::time::timeout;

use super::config::{SshAuth, SshProfile};
use super::known_hosts::{HostKeyMismatch, KnownHostsStore};
use super::SshHub;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SshSessionState {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub profile_id: String,
    pub state: SshSessionState,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub home: String,
    pub message: String,
}

impl SshSessionInfo {
    fn connecting(profile: &SshProfile) -> Self {
        Self {
            profile_id: profile.id.clone(),
            state: SshSessionState::Connecting,
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            home: String::new(),
            message: String::new(),
        }
    }

    fn connected(profile: &SshProfile, home: String) -> Self {
        Self {
            profile_id: profile.id.clone(),
            state: SshSessionState::Connected,
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            home,
            message: String::new(),
        }
    }

    pub fn disconnected(profile: &SshProfile, message: impl Into<String>) -> Self {
        Self {
            profile_id: profile.id.clone(),
            state: SshSessionState::Disconnected,
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            home: String::new(),
            message: message.into(),
        }
    }

    fn error(profile: &SshProfile, message: impl Into<String>) -> Self {
        Self {
            profile_id: profile.id.clone(),
            state: SshSessionState::Error,
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            home: String::new(),
            message: message.into(),
        }
    }
}

/// Live handle kept in `SshHub::sessions`. Owns the russh `Handle` plus a flag
/// used by the keepalive task to know when to stop.
///
/// Cloning shares the same underlying SSH connection via Arc.
pub struct SessionHandle {
    pub(crate) inner: Arc<Mutex<russh::client::Handle<ClientHandler>>>,
    pub(crate) closed: Arc<AtomicBool>,
    pub(crate) profile: SshProfile,
    pub(crate) home: String,
}

impl Clone for SessionHandle {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            closed: self.closed.clone(),
            profile: self.profile.clone(),
            home: self.home.clone(),
        }
    }
}

impl SessionHandle {
    pub fn info(&self) -> SshSessionInfo {
        if self.closed.load(Ordering::SeqCst) {
            SshSessionInfo::disconnected(&self.profile, "SSH 连接已断开。")
        } else {
            SshSessionInfo::connected(&self.profile, self.home.clone())
        }
    }
}

/// Minimal russh client handler: verifies the server host key against the TOFU
/// store *inside* the handshake, so a mismatched key aborts the connection before
/// any credential is sent. Also records disconnect reasons.
pub struct ClientHandler {
    pub(crate) closed: Arc<AtomicBool>,
    /// Forwards of the owning profile; `-R` connections are looked up here.
    pub(crate) forwards: Arc<super::forward::ForwardRegistry>,
    pub(crate) profile_id: String,
    /// Shared TOFU store; `None` only in unit tests that do not exercise keys.
    pub(crate) known_hosts: Option<Arc<KnownHostsStore>>,
    pub(crate) host: String,
    pub(crate) port: u16,
    /// Set when `check_server_key` rejected the key, so the caller can emit the
    /// mismatch event with both fingerprints.
    pub(crate) mismatch: Arc<std::sync::Mutex<Option<HostKeyMismatch>>>,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = RusshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let Some(store) = self.known_hosts.as_ref() else {
            return Ok(true);
        };
        let blob = server_public_key.public_key_bytes();
        match store.verify(&self.host, self.port, &blob) {
            Ok(()) => {
                // First contact for this host: record the key now that the
                // handshake has proven the server actually owns it.
                let _ = store.trust(
                    &self.host,
                    self.port,
                    server_public_key.algorithm().as_str(),
                    &blob,
                );
                Ok(true)
            }
            Err(mismatch) => {
                if let Ok(mut slot) = self.mismatch.lock() {
                    *slot = Some(mismatch);
                }
                Ok(false)
            }
        }
    }

    async fn channel_open_confirmation(
        &mut self,
        _id: ChannelId,
        _max_packet_size: u32,
        _window_size: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    /// The SSH server accepted a connection on a `-R` listener. Hand it to the
    /// forward registry, which connects to the local service and pumps bytes.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Ok(port) = u16::try_from(connected_port) else {
            return Ok(());
        };
        let Some(target) = self.forwards.find_remote(&self.profile_id, port) else {
            // No matching forward: dropping the channel closes it.
            return Ok(());
        };
        let stream = channel.into_stream();
        tokio::spawn(async move {
            super::forward::pump_remote_channel(stream, target).await;
        });
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _id: ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn disconnected(
        &mut self,
        _reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Connect to an SSH server using the given profile. Returns a ready-to-use
/// `SessionHandle` on success. The caller is responsible for storing it in the hub.
///
/// The host key is verified by [`ClientHandler::check_server_key`] during the
/// handshake; on mismatch the connection fails and the mismatch is returned so
/// the caller can emit `ssh-hostkey-mismatch`.
pub async fn connect_session(
    hub: &SshHub,
    profile: &SshProfile,
    password: Option<&str>,
    passphrase: Option<&str>,
) -> Result<SessionHandle, String> {
    hub.emit_session(&SshSessionInfo::connecting(profile));

    let config = Arc::new(russh::client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        ..Default::default()
    });

    let closed = Arc::new(AtomicBool::new(false));
    let mismatch = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        closed: closed.clone(),
        forwards: hub.forwards.clone(),
        profile_id: profile.id.clone(),
        known_hosts: Some(hub.known_hosts.clone()),
        host: profile.host.clone(),
        port: profile.port,
        mismatch: mismatch.clone(),
    };

    let addr = format!("{}:{}", profile.host, profile.port);
    let connect_future = client::connect(config, &addr, handler);
    let connected = timeout(CONNECT_TIMEOUT, connect_future).await;
    let mut handle = match connected {
        Err(_) => {
            hub.emit_host_key_mismatch_if_any(profile, &mismatch);
            return Err(format!(
                "SSH 连接失败：连接超时（{} 秒）。",
                CONNECT_TIMEOUT.as_secs()
            ));
        }
        Ok(Err(error)) => {
            hub.emit_host_key_mismatch_if_any(profile, &mismatch);
            return Err(format!("SSH 连接失败：{error}"));
        }
        Ok(Ok(handle)) => handle,
    };

    if let Err(error) = authenticate(&mut handle, profile, password, passphrase).await {
        hub.emit_session(&SshSessionInfo::error(profile, error.clone()));
        return Err(error);
    }

    let home = fetch_home(&mut handle)
        .await
        .unwrap_or_else(|_| "/".to_string());

    Ok(SessionHandle {
        inner: Arc::new(Mutex::new(handle)),
        closed,
        profile: profile.clone(),
        home,
    })
}

async fn authenticate(
    handle: &mut russh::client::Handle<ClientHandler>,
    profile: &SshProfile,
    password: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(), String> {
    match profile.auth {
        SshAuth::Password => {
            let secret = password
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "SSH 认证失败：未提供密码。".to_string())?;
            let ok = handle
                .authenticate_password(&profile.username, secret)
                .await
                .map_err(|error| format!("SSH 认证失败：{error}"))?;
            if !ok {
                return Err("SSH 认证失败：用户名或密码错误。".into());
            }
        }
        SshAuth::Key => {
            let key_data = tokio::fs::read_to_string(&profile.key_path)
                .await
                .map_err(|error| format!("私钥文件无效：{error}"))?;
            let key_pair = if let Some(pass) = passphrase.filter(|value| !value.is_empty()) {
                russh::keys::decode_secret_key(&key_data, Some(pass))
                    .map_err(|error| format!("私钥文件无效：{error}"))?
            } else {
                russh::keys::decode_secret_key(&key_data, None)
                    .map_err(|error| format!("私钥文件无效：{error}"))?
            };
            // `PrivateKeyWithHashAlg::new` returns a Result and lives under
            // `russh::keys::key`, not directly in `russh::keys`.
            let key_with_hash =
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)
                    .map_err(|error| format!("私钥文件无效：{error}"))?;
            let ok = handle
                .authenticate_publickey(&profile.username, key_with_hash)
                .await
                .map_err(|error| format!("SSH 认证失败：{error}"))?;
            if !ok {
                return Err("SSH 认证失败：服务器拒绝了该密钥。".into());
            }
        }
        SshAuth::Agent => {
            // Windows exposes the OpenSSH agent as a named pipe; Unix uses a
            // socket path from $SSH_AUTH_SOCK.
            #[cfg(windows)]
            let mut agent = russh::keys::agent::client::AgentClient::connect_named_pipe(
                r"\\.\pipe\openssh-ssh-agent",
            )
            .await
            .map_err(|error| format!("SSH Agent 不可用：{error}"))?;
            #[cfg(not(windows))]
            let mut agent = {
                let sock = std::env::var("SSH_AUTH_SOCK")
                    .map_err(|_| "SSH Agent 不可用：未设置 SSH_AUTH_SOCK。".to_string())?;
                russh::keys::agent::client::AgentClient::connect_uds(sock)
                    .await
                    .map_err(|error| format!("SSH Agent 不可用：{error}"))?
            };
            let identities = agent
                .request_identities()
                .await
                .map_err(|error| format!("SSH Agent 不可用：{error}"))?;
            if identities.is_empty() {
                return Err("SSH Agent 不可用：Agent 中没有可用密钥。".into());
            }
            let mut authenticated = false;
            for pubkey in identities {
                match handle
                    .authenticate_publickey_with(&profile.username, pubkey, &mut agent)
                    .await
                {
                    Ok(true) => {
                        authenticated = true;
                        break;
                    }
                    Ok(false) => continue,
                    Err(_) => continue,
                }
            }
            if !authenticated {
                return Err("SSH 认证失败：Agent 中的密钥均被服务器拒绝。".into());
            }
        }
    }
    Ok(())
}

async fn fetch_home(handle: &mut russh::client::Handle<ClientHandler>) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 会话通道打开失败：{error}"))?;
    channel
        .exec(true, "printf '%s' \"$HOME\"")
        .await
        .map_err(|error| format!("获取家目录失败：{error}"))?;
    let mut buf = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => buf.extend_from_slice(&data),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            Some(_) => {}
        }
    }
    let home = String::from_utf8_lossy(&buf).trim().to_string();
    if home.is_empty() {
        return Err("获取家目录失败：返回为空。".into());
    }
    Ok(home)
}
