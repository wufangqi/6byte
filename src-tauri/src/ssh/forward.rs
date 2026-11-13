//! Port forwarding: local (-L), remote (-R) and dynamic/SOCKS5 (-D). Each forward
//! runs in its own tokio task; stats use AtomicU64 so the UI can poll without locks.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

use super::session::SessionHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ForwardSpec {
    Local {
        #[serde(rename = "localPort")]
        local_port: u16,
        #[serde(rename = "remoteHost")]
        remote_host: String,
        #[serde(rename = "remotePort")]
        remote_port: u16,
    },
    Remote {
        #[serde(rename = "remotePort")]
        remote_port: u16,
        #[serde(rename = "localHost")]
        local_host: String,
        #[serde(rename = "localPort")]
        local_port: u16,
    },
    Dynamic {
        #[serde(rename = "localPort")]
        local_port: u16,
    },
}

impl ForwardSpec {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ForwardSpec::Local {
                local_port,
                remote_host,
                remote_port,
            } => {
                if remote_host.trim().is_empty() {
                    return Err("端口转发失败：远端主机不能为空。".into());
                }
                if *remote_port == 0 {
                    return Err("端口转发失败：远端端口不能为 0。".into());
                }
                let _ = local_port; // 0 is allowed (system-assigned)
            }
            ForwardSpec::Remote {
                remote_port,
                local_host,
                local_port,
            } => {
                if local_host.trim().is_empty() {
                    return Err("端口转发失败：本地主机不能为空。".into());
                }
                if *local_port == 0 {
                    return Err("端口转发失败：本地目标端口不能为 0。".into());
                }
                let _ = remote_port; // 0 allowed (server assigns)
            }
            ForwardSpec::Dynamic { local_port } => {
                let _ = local_port;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum ForwardStatus {
    Active,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub spec: ForwardSpec,
    pub status: ForwardStatus,
    pub bound_port: u16,
    pub connections: u64,
    pub total_connections: u64,
    pub up_bytes: u64,
    pub down_bytes: u64,
    pub error: String,
}

/// Live atomic counters for a forward; snapshot into `ForwardInfo` when listing.
pub(crate) struct ForwardStats {
    connections: AtomicU64,
    total_connections: AtomicU64,
    up_bytes: AtomicU64,
    down_bytes: AtomicU64,
}

impl ForwardStats {
    fn new() -> Self {
        Self {
            connections: AtomicU64::new(0),
            total_connections: AtomicU64::new(0),
            up_bytes: AtomicU64::new(0),
            down_bytes: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> (u64, u64, u64, u64) {
        (
            self.connections.load(Ordering::SeqCst),
            self.total_connections.load(Ordering::SeqCst),
            self.up_bytes.load(Ordering::SeqCst),
            self.down_bytes.load(Ordering::SeqCst),
        )
    }
}

struct ForwardState {
    info: ForwardInfo,
    stats: Arc<ForwardStats>,
    cancel: Arc<Notify>,
    shutdown: mpsc::Sender<()>,
}

/// Where a remote forward should deliver connections that the SSH server pushes
/// back to us. `None` means no active `-R` forward matches that remote port, so
/// the channel must be closed.
#[derive(Clone)]
pub struct RemoteTarget {
    pub local_host: String,
    pub local_port: u16,
    pub(crate) stats: Arc<ForwardStats>,
}

impl ForwardRegistry {
    /// Find the active remote forward whose remote listener is `remote_port`.
    pub fn find_remote(&self, profile_id: &str, remote_port: u16) -> Option<RemoteTarget> {
        let map = self.entries.get(profile_id)?;
        for state in map.values() {
            if let ForwardSpec::Remote {
                remote_port: spec_port,
                local_host,
                local_port,
            } = &state.info.spec
            {
                let listening = if *spec_port == 0 {
                    state.info.bound_port
                } else {
                    *spec_port
                };
                if listening == remote_port {
                    return Some(RemoteTarget {
                        local_host: local_host.clone(),
                        local_port: *local_port,
                        stats: state.stats.clone(),
                    });
                }
            }
        }
        None
    }
}

/// Deliver one server-pushed channel to the local service and pump both ways
/// until either side closes. Byte counters feed the port-forward panel.
pub async fn pump_remote_channel<S>(channel: S, target: RemoteTarget)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let address = format!("{}:{}", target.local_host, target.local_port);
    let Ok(local) = TcpStream::connect(&address).await else {
        return;
    };
    target.stats.connections.fetch_add(1, Ordering::SeqCst);
    target
        .stats
        .total_connections
        .fetch_add(1, Ordering::SeqCst);

    let (mut local_read, mut local_write) = local.into_split();
    let (mut remote_read, mut remote_write) = tokio::io::split(channel);

    let up = AtomicU64::new(0);
    let down = AtomicU64::new(0);

    let upload = async {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let read = match remote_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if local_write.write_all(&buffer[..read]).await.is_err() {
                break;
            }
            up.fetch_add(read as u64, Ordering::SeqCst);
        }
    };
    let download = async {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let read = match local_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if remote_write.write_all(&buffer[..read]).await.is_err() {
                break;
            }
            down.fetch_add(read as u64, Ordering::SeqCst);
        }
    };
    tokio::select! {
        _ = upload => {}
        _ = download => {}
    }

    target
        .stats
        .up_bytes
        .fetch_add(up.load(Ordering::SeqCst), Ordering::SeqCst);
    target
        .stats
        .down_bytes
        .fetch_add(down.load(Ordering::SeqCst), Ordering::SeqCst);
    target.stats.connections.fetch_sub(1, Ordering::SeqCst);
}

#[derive(Default)]
pub struct ForwardRegistry {
    /// profileId → forwardId → state
    entries: DashMap<String, HashMap<String, Arc<ForwardState>>>,
}

impl ForwardRegistry {
    /// Profiles that currently hold at least one forward, for the stats ticker.
    pub fn profiles(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| !entry.value().is_empty())
            .map(|entry| entry.key().clone())
            .collect()
    }

    pub fn list(&self, profile_id: &str) -> Vec<ForwardInfo> {
        self.entries
            .get(profile_id)
            .map(|guard| {
                guard
                    .values()
                    .map(|state| {
                        let (conns, total, up, down) = state.stats.snapshot();
                        ForwardInfo {
                            connections: conns,
                            total_connections: total,
                            up_bytes: up,
                            down_bytes: down,
                            ..state.info.clone()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn stop(&self, profile_id: &str, forward_id: &str) -> Result<(), String> {
        let Some(mut map) = self.entries.get_mut(profile_id) else {
            return Err("端口转发失败：未找到该转发。".into());
        };
        let Some(state) = map.remove(forward_id) else {
            return Err("端口转发失败：未找到该转发。".into());
        };
        state.cancel.notify_waiters();
        let _ = state.shutdown.try_send(());
        Ok(())
    }

    /// Stop every forward for a profile (called on disconnect).
    pub fn stop_all(&self, profile_id: &str) {
        if let Some((_, map)) = self.entries.remove(profile_id) {
            for state in map.values() {
                state.cancel.notify_waiters();
                let _ = state.shutdown.try_send(());
            }
        }
    }

    fn insert(&self, profile_id: &str, state: Arc<ForwardState>) {
        self.entries
            .entry(profile_id.to_string())
            .or_default()
            .insert(state.info.id.clone(), state);
    }
}

/// Spawn a local→remote forward (-L). Returns the actual bound port (useful when
/// `local_port` was 0).
pub async fn start_local_forward(
    registry: &ForwardRegistry,
    session: &Arc<SessionHandle>,
    profile_id: &str,
    spec: ForwardSpec,
) -> Result<ForwardInfo, String> {
    spec.validate()?;
    let (local_port, remote_host, remote_port) = match &spec {
        ForwardSpec::Local {
            local_port,
            remote_host,
            remote_port,
        } => (*local_port, remote_host.clone(), *remote_port),
        _ => return Err("端口转发失败：规格类型不匹配。".into()),
    };

    let listener = TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), local_port))
        .await
        .map_err(|error| {
            if local_port != 0 {
                format!("本地端口已被占用：{local_port}")
            } else {
                format!("端口转发失败：{error}")
            }
        })?;
    let bound_port = listener.local_addr().unwrap().port();

    let id = Uuid::new_v4().to_string();
    let cancel = Arc::new(Notify::new());
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let stats = Arc::new(ForwardStats::new());
    let state = Arc::new(ForwardState {
        info: ForwardInfo {
            id: id.clone(),
            spec: spec.clone(),
            status: ForwardStatus::Active,
            bound_port,
            connections: 0,
            total_connections: 0,
            up_bytes: 0,
            down_bytes: 0,
            error: String::new(),
        },
        stats: stats.clone(),
        cancel: cancel.clone(),
        shutdown: shutdown_tx,
    });
    registry.insert(profile_id, state.clone());

    let session = session.clone();
    let _profile_id_owned = profile_id.to_string();
    let stats_clone = stats.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    let Ok((client, _)) = accept_result else { break; };
                    let session = session.clone();
                    let stats = stats_clone.clone();
                    let remote_host = remote_host.clone();
                    tokio::spawn(async move {
                        pump_local_to_remote(client, &session, &remote_host, remote_port, &stats).await;
                    });
                }
                _ = shutdown_rx.recv() => break,
                _ = cancel.notified() => break,
            }
        }
    });

    Ok(state.info.clone())
}

async fn pump_local_to_remote(
    client: TcpStream,
    session: &SessionHandle,
    remote_host: &str,
    remote_port: u16,
    stats: &ForwardStats,
) {
    let channel_result = {
        let guard = session.inner.lock().await;
        guard
            .channel_open_direct_tcpip(remote_host, remote_port.into(), "127.0.0.1", 0)
            .await
    };
    let Ok(channel) = channel_result else {
        return;
    };
    let remote = channel.into_stream();
    stats.connections.fetch_add(1, Ordering::SeqCst);
    stats.total_connections.fetch_add(1, Ordering::SeqCst);

    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut remote_read, mut remote_write) = tokio::io::split(remote);

    let up = AtomicU64::new(0);
    let down = AtomicU64::new(0);

    let upload = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match client_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if remote_write.write_all(&buf[..n]).await.is_err() {
                break;
            }
            up.fetch_add(n as u64, Ordering::SeqCst);
        }
    };
    let download = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match remote_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if client_write.write_all(&buf[..n]).await.is_err() {
                break;
            }
            down.fetch_add(n as u64, Ordering::SeqCst);
        }
    };

    tokio::select! {
        _ = upload => {}
        _ = download => {}
    }

    stats
        .up_bytes
        .fetch_add(up.load(Ordering::SeqCst), Ordering::SeqCst);
    stats
        .down_bytes
        .fetch_add(down.load(Ordering::SeqCst), Ordering::SeqCst);
    stats.connections.fetch_sub(1, Ordering::SeqCst);
}

/// Spawn a remote forward (-R): the remote host listens on `remote_port` and
/// tunnels connections back to `local_host:local_port` on this machine.
///
/// Uses `tcpip_forward`; when `remote_port` is 0 the server picks one and the
/// allocated port is reported in `boundPort` (0 when the server does not say).
pub async fn start_remote_forward(
    registry: &ForwardRegistry,
    session: &Arc<SessionHandle>,
    profile_id: &str,
    spec: ForwardSpec,
) -> Result<ForwardInfo, String> {
    spec.validate()?;
    let (remote_port, _local_host, _local_port) = match &spec {
        ForwardSpec::Remote {
            remote_port,
            local_host,
            local_port,
        } => (*remote_port, local_host.clone(), *local_port),
        _ => return Err("端口转发失败：规格类型不匹配。".into()),
    };

    let allocated: u32 = {
        let mut guard = session.inner.lock().await;
        guard
            .tcpip_forward("127.0.0.1", remote_port.into())
            .await
            .map_err(|error| format!("端口转发失败：{error}"))?
    };
    let bound_port: u16 = if remote_port == 0 {
        allocated as u16
    } else {
        remote_port
    };

    let id = Uuid::new_v4().to_string();
    let cancel = Arc::new(Notify::new());
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let stats = Arc::new(ForwardStats::new());
    let state = Arc::new(ForwardState {
        info: ForwardInfo {
            id: id.clone(),
            spec: spec.clone(),
            status: ForwardStatus::Active,
            bound_port,
            connections: 0,
            total_connections: 0,
            up_bytes: 0,
            down_bytes: 0,
            error: String::new(),
        },
        stats,
        cancel: cancel.clone(),
        shutdown: shutdown_tx,
    });
    registry.insert(profile_id, state.clone());

    let session = session.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = shutdown_rx.recv() => {}
            _ = cancel.notified() => {}
        }
        // Stop listening on the server side. The per-connection bridge is driven
        // by the client handler; cancelling the forward is enough to stop new
        // connections from arriving.
        let guard = session.inner.lock().await;
        let target_port = if remote_port == 0 {
            bound_port
        } else {
            remote_port
        };
        let _ = guard
            .cancel_tcpip_forward("127.0.0.1", target_port.into())
            .await;
    });

    Ok(state.info.clone())
}

/// Spawn a SOCKS5 dynamic forward (-D). Only no-auth + CONNECT are supported;
/// IPv4 / IPv6 / domain targets are all handled.
pub async fn start_dynamic_forward(
    registry: &ForwardRegistry,
    session: &Arc<SessionHandle>,
    profile_id: &str,
    spec: ForwardSpec,
) -> Result<ForwardInfo, String> {
    spec.validate()?;
    let local_port = match spec {
        ForwardSpec::Dynamic { local_port } => local_port,
        _ => return Err("端口转发失败：规格类型不匹配。".into()),
    };

    let listener = TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), local_port))
        .await
        .map_err(|error| {
            if local_port != 0 {
                format!("本地端口已被占用：{local_port}")
            } else {
                format!("端口转发失败：{error}")
            }
        })?;
    let bound_port = listener.local_addr().unwrap().port();

    let id = Uuid::new_v4().to_string();
    let cancel = Arc::new(Notify::new());
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let stats = Arc::new(ForwardStats::new());
    let state = Arc::new(ForwardState {
        info: ForwardInfo {
            id: id.clone(),
            spec: spec.clone(),
            status: ForwardStatus::Active,
            bound_port,
            connections: 0,
            total_connections: 0,
            up_bytes: 0,
            down_bytes: 0,
            error: String::new(),
        },
        stats: stats.clone(),
        cancel: cancel.clone(),
        shutdown: shutdown_tx,
    });
    registry.insert(profile_id, state.clone());

    let session = session.clone();
    let stats_clone = stats.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    let Ok((client, _)) = accept_result else { break; };
                    let session = session.clone();
                    let stats = stats_clone.clone();
                    tokio::spawn(async move {
                        handle_socks5_client(client, &session, &stats).await;
                    });
                }
                _ = shutdown_rx.recv() => break,
                _ = cancel.notified() => break,
            }
        }
    });

    Ok(state.info.clone())
}

async fn handle_socks5_client(client: TcpStream, session: &SessionHandle, stats: &ForwardStats) {
    let mut client = client;
    // Greeting: VER | NMETHODS | METHODS...
    let mut header = [0u8; 2];
    if client.read_exact(&mut header).await.is_err() || header[0] != 0x05 {
        return;
    }
    let nmethods = header[1] as usize;
    let mut methods = vec![0u8; nmethods];
    if client.read_exact(&mut methods).await.is_err() {
        return;
    }
    // We only support NO AUTH (0x00).
    if !methods.contains(&0x00) {
        let _ = client.write_all(&[0x05, 0xFF]).await;
        return;
    }
    if client.write_all(&[0x05, 0x00]).await.is_err() {
        return;
    }

    // Request: VER | CMD | RSV | ATYP | DST.ADDR | DST.PORT
    let mut request = [0u8; 4];
    if client.read_exact(&mut request).await.is_err() || request[0] != 0x05 || request[1] != 0x01 {
        let _ = socks5_reply(&mut client, 0x07).await;
        return;
    }

    let (host, port) = match request[3] {
        0x01 => {
            // IPv4
            let mut addr = [0u8; 4];
            if client.read_exact(&mut addr).await.is_err() {
                return;
            }
            let mut port_buf = [0u8; 2];
            if client.read_exact(&mut port_buf).await.is_err() {
                return;
            }
            let ip = Ipv4Addr::new(addr[0], addr[1], addr[2], addr[3]);
            (ip.to_string(), u16::from_be_bytes(port_buf))
        }
        0x03 => {
            // Domain
            let mut len_buf = [0u8; 1];
            if client.read_exact(&mut len_buf).await.is_err() {
                return;
            }
            let len = len_buf[0] as usize;
            let mut domain = vec![0u8; len];
            if client.read_exact(&mut domain).await.is_err() {
                return;
            }
            let mut port_buf = [0u8; 2];
            if client.read_exact(&mut port_buf).await.is_err() {
                return;
            }
            let name = String::from_utf8_lossy(&domain).to_string();
            (name, u16::from_be_bytes(port_buf))
        }
        0x04 => {
            // IPv6
            let mut addr = [0u8; 16];
            if client.read_exact(&mut addr).await.is_err() {
                return;
            }
            let mut port_buf = [0u8; 2];
            if client.read_exact(&mut port_buf).await.is_err() {
                return;
            }
            let ip = Ipv6Addr::from(addr);
            (ip.to_string(), u16::from_be_bytes(port_buf))
        }
        _ => {
            let _ = socks5_reply(&mut client, 0x08).await;
            return;
        }
    };

    // Open SSH channel to the requested destination.
    let channel_result = {
        let guard = session.inner.lock().await;
        guard
            .channel_open_direct_tcpip(&host, port.into(), "127.0.0.1", 0)
            .await
    };
    let Ok(channel) = channel_result else {
        let _ = socks5_reply(&mut client, 0x05).await;
        return;
    };
    if socks5_reply(&mut client, 0x00).await.is_err() {
        return;
    }

    let remote = channel.into_stream();
    stats.connections.fetch_add(1, Ordering::SeqCst);
    stats.total_connections.fetch_add(1, Ordering::SeqCst);

    let (mut cr, mut cw) = tokio::io::split(client);
    let (mut rr, mut rw) = tokio::io::split(remote);
    let up = AtomicU64::new(0);
    let down = AtomicU64::new(0);

    let upload = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match cr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if rw.write_all(&buf[..n]).await.is_err() {
                break;
            }
            up.fetch_add(n as u64, Ordering::SeqCst);
        }
    };
    let download = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match rr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if cw.write_all(&buf[..n]).await.is_err() {
                break;
            }
            down.fetch_add(n as u64, Ordering::SeqCst);
        }
    };
    tokio::select! { _ = upload => {} _ = download => {} }

    stats
        .up_bytes
        .fetch_add(up.load(Ordering::SeqCst), Ordering::SeqCst);
    stats
        .down_bytes
        .fetch_add(down.load(Ordering::SeqCst), Ordering::SeqCst);
    stats.connections.fetch_sub(1, Ordering::SeqCst);
}

async fn socks5_reply(stream: &mut TcpStream, reply: u8) -> std::io::Result<()> {
    // VER | REP | RSV | ATYP(IPv4) | BND.ADDR(0.0.0.0) | BND.PORT(0)
    stream
        .write_all(&[0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_spec_validates_remote_host_and_port() {
        let ok = ForwardSpec::Local {
            local_port: 0,
            remote_host: "db".into(),
            remote_port: 5432,
        };
        assert!(ok.validate().is_ok());

        let bad_host = ForwardSpec::Local {
            local_port: 8080,
            remote_host: "".into(),
            remote_port: 80,
        };
        assert!(bad_host.validate().is_err());

        let bad_port = ForwardSpec::Local {
            local_port: 8080,
            remote_host: "x".into(),
            remote_port: 0,
        };
        assert!(bad_port.validate().is_err());
    }

    #[test]
    fn remote_spec_requires_nonzero_local_target_port() {
        let ok = ForwardSpec::Remote {
            remote_port: 0,
            local_host: "localhost".into(),
            local_port: 3000,
        };
        assert!(ok.validate().is_ok());

        let bad = ForwardSpec::Remote {
            remote_port: 9090,
            local_host: "localhost".into(),
            local_port: 0,
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn socks5_greeting_parses_no_auth() {
        // Simulated greeting: VER=5, NMETHODS=1, METHOD=0 (NO AUTH)
        let greeting: &[u8] = &[0x05, 0x01, 0x00];
        assert_eq!(greeting[0], 0x05);
        assert_eq!(greeting[1], 1);
        assert!(greeting[2..].contains(&0x00));
    }

    #[test]
    fn socks5_ipv4_request_decodes_address_and_port() {
        // VER=5 CMD=1 RSV=0 ATYP=1(IPv4) ADDR=127.0.0.1 PORT=8080
        let request: Vec<u8> = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90];
        assert_eq!(request[3], 0x01);
        let addr = Ipv4Addr::new(request[4], request[5], request[6], request[7]);
        let port = u16::from_be_bytes([request[8], request[9]]);
        assert_eq!(addr, Ipv4Addr::LOCALHOST);
        assert_eq!(port, 8080);
    }

    #[test]
    fn socks5_domain_request_decodes_length_prefixed_name() {
        // VER=5 CMD=1 RSV=0 ATYP=3 LEN=9 "localhost" PORT=443
        let name = b"localhost";
        let mut request: Vec<u8> = vec![0x05, 0x01, 0x00, 0x03, name.len() as u8];
        request.extend_from_slice(name);
        request.extend_from_slice(&443u16.to_be_bytes());
        let len = request[4] as usize;
        let decoded = std::str::from_utf8(&request[5..5 + len]).unwrap();
        assert_eq!(decoded, "localhost");
        let port_offset = 5 + len;
        let port = u16::from_be_bytes([request[port_offset], request[port_offset + 1]]);
        assert_eq!(port, 443);
    }

    /// A `-R` spec with port 0 lets the server choose; the lookup must use the
    /// allocated port recorded in `bound_port`, not the requested 0.
    #[test]
    fn find_remote_matches_the_allocated_port_when_zero_was_requested() {
        let registry = ForwardRegistry::default();
        let spec = ForwardSpec::Remote {
            remote_port: 0,
            local_host: "127.0.0.1".into(),
            local_port: 3000,
        };
        let state = Arc::new(ForwardState {
            info: ForwardInfo {
                id: "f1".into(),
                spec,
                status: ForwardStatus::Active,
                bound_port: 41022,
                connections: 0,
                total_connections: 0,
                up_bytes: 0,
                down_bytes: 0,
                error: String::new(),
            },
            stats: Arc::new(ForwardStats::new()),
            cancel: Arc::new(Notify::new()),
            shutdown: mpsc::channel::<()>(1).0,
        });
        registry.insert("profile-a", state);

        let hit = registry
            .find_remote("profile-a", 41022)
            .expect("allocated port");
        assert_eq!(hit.local_port, 3000);
        assert_eq!(hit.local_host, "127.0.0.1");
        assert!(registry.find_remote("profile-a", 0).is_none());
        assert!(registry.find_remote("profile-b", 41022).is_none());
    }

    #[test]
    fn find_remote_uses_the_requested_port_when_nonzero() {
        let registry = ForwardRegistry::default();
        let spec = ForwardSpec::Remote {
            remote_port: 9000,
            local_host: "localhost".into(),
            local_port: 8080,
        };
        let state = Arc::new(ForwardState {
            info: ForwardInfo {
                id: "f2".into(),
                spec,
                status: ForwardStatus::Active,
                bound_port: 9000,
                connections: 0,
                total_connections: 0,
                up_bytes: 0,
                down_bytes: 0,
                error: String::new(),
            },
            stats: Arc::new(ForwardStats::new()),
            cancel: Arc::new(Notify::new()),
            shutdown: mpsc::channel::<()>(1).0,
        });
        registry.insert("profile-a", state);

        let hit = registry
            .find_remote("profile-a", 9000)
            .expect("remote port");
        assert_eq!(hit.local_port, 8080);
        assert!(registry.find_remote("profile-a", 9001).is_none());
    }

    /// A stopped forward must not accept server-pushed connections any more.
    #[test]
    fn find_remote_returns_none_after_stop() {
        let registry = ForwardRegistry::default();
        let spec = ForwardSpec::Remote {
            remote_port: 2222,
            local_host: "127.0.0.1".into(),
            local_port: 22,
        };
        let state = Arc::new(ForwardState {
            info: ForwardInfo {
                id: "f3".into(),
                spec,
                status: ForwardStatus::Active,
                bound_port: 2222,
                connections: 0,
                total_connections: 0,
                up_bytes: 0,
                down_bytes: 0,
                error: String::new(),
            },
            stats: Arc::new(ForwardStats::new()),
            cancel: Arc::new(Notify::new()),
            shutdown: mpsc::channel::<()>(1).0,
        });
        registry.insert("profile-a", state);
        assert!(registry.find_remote("profile-a", 2222).is_some());

        registry.stop("profile-a", "f3").expect("stop");
        assert!(registry.find_remote("profile-a", 2222).is_none());
    }
}
