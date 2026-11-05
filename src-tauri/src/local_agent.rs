//! Loopback API for a local agent.
//!
//! The server binds `127.0.0.1` on an ephemeral port and answers only with the
//! bearer token issued when it starts. It can read the workspace and the editor
//! snapshot. It cannot write files. A candidate names the revision and range the
//! caller saw. The editor moves that range when the person types outside it, and
//! drops it when the person types inside it. Nothing is written until they accept.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

use crate::commands;
use crate::grep;
use crate::skip::is_skipped_dir;
use crate::tree::list_dir_children;

const EDITOR_TEXT_CAP: usize = 400_000;
const SELECTION_CAP: usize = 32_000;
const CANDIDATE_CAP: usize = 64 * 1024;
const READ_RANGE_CAP: u64 = 80;
const DOCUMENT_CAP: usize = 2 * 1024 * 1024;
const FIND_CAP: usize = 200;
const GREP_CAP: usize = 40;
const BODY_CAP: usize = 256 * 1024;
const HEADER_CAP: usize = 8 * 1024;

const SECRET_EXTENSIONS: &[&str] = &[
    "pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "env",
];
const SECRET_KEY_PREFIXES: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SECRET_NAMES: &[&str] = &["credentials", "secrets", "secret"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub port: u16,
    pub token: String,
    pub origin: String,
    pub discovery_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub origin: String,
    pub discovery_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorSnapshot {
    path: String,
    name: String,
    revision: u64,
    truncated: bool,
    text: String,
    selection_from: u32,
    selection_to: u32,
    selection_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CandidateEvent {
    id: u64,
    path: String,
    revision: u64,
    from: u32,
    to: u32,
    text: String,
}

enum OfferDecision {
    Offered { from: u32, to: u32, revision: u64 },
    Stale,
    Unavailable,
}

struct Core {
    token: String,
    root: Option<PathBuf>,
    denylist: Vec<String>,
    editor: EditorSnapshot,
    app: Option<AppHandle>,
    next_offer: u64,
    pending: HashMap<u64, oneshot::Sender<OfferDecision>>,
}

struct Running {
    core: Arc<Mutex<Core>>,
    stop: watch::Sender<bool>,
    port: u16,
    token: String,
    origin: String,
    discovery_path: Option<String>,
}

pub struct LocalAgent {
    running: Mutex<Option<Running>>,
}

impl Default for LocalAgent {
    fn default() -> Self {
        Self {
            running: Mutex::new(None),
        }
    }
}

impl LocalAgent {
    pub fn start(
        &self,
        app: &AppHandle,
        root: String,
        denylist: String,
    ) -> Result<StartInfo, String> {
        let mut slot = self.running.lock().expect("local agent lock");
        if let Some(running) = slot.as_ref() {
            apply_gate(&running.core, &root, &denylist)?;
            return Ok(info_of(running));
        }

        let token = new_token()?;
        let (gate_root, rules) = parse_gate(&root, &denylist)?;
        let core = Arc::new(Mutex::new(Core {
            token: token.clone(),
            root: gate_root,
            denylist: rules,
            editor: EditorSnapshot::default(),
            app: Some(app.clone()),
            next_offer: 1,
            pending: HashMap::new(),
        }));
        let (stop, watch_rx) = watch::channel(false);
        let port = spawn_server(core.clone(), watch_rx).map_err(|error| error.to_string())?;
        let origin = format!("http://127.0.0.1:{port}");
        let discovery_path = write_discovery(app, &origin, &token);
        let running = Running {
            core,
            stop,
            port,
            token,
            origin,
            discovery_path,
        };
        let info = info_of(&running);
        *slot = Some(running);
        Ok(info)
    }

    pub fn stop(&self, app: &AppHandle) {
        let mut slot = self.running.lock().expect("local agent lock");
        if let Some(running) = slot.take() {
            let _ = running.stop.send(true);
            if let Some(path) = &running.discovery_path {
                let _ = fs::remove_file(path);
            } else if let Some(path) = discovery_file(app) {
                let _ = fs::remove_file(path);
            }
        }
    }

    pub fn status(&self) -> StatusInfo {
        let slot = self.running.lock().expect("local agent lock");
        match slot.as_ref() {
            Some(running) => StatusInfo {
                enabled: true,
                port: running.port,
                token: running.token.clone(),
                origin: running.origin.clone(),
                discovery_path: running.discovery_path.clone(),
            },
            None => StatusInfo {
                enabled: false,
                port: 0,
                token: String::new(),
                origin: String::new(),
                discovery_path: None,
            },
        }
    }

    fn set_editor(&self, snapshot: EditorSnapshot) {
        let slot = self.running.lock().expect("local agent lock");
        let Some(running) = slot.as_ref() else {
            return;
        };
        let mut core = running.core.lock().expect("local agent core");
        core.editor = snapshot;
    }

    pub fn set_gate(&self, root: String, denylist: String) -> Result<(), String> {
        let slot = self.running.lock().expect("local agent lock");
        let Some(running) = slot.as_ref() else {
            return Ok(());
        };
        apply_gate(&running.core, &root, &denylist)
    }

    pub fn resolve_candidate(&self, id: u64, status: &str, from: u32, to: u32, revision: u64) {
        let slot = self.running.lock().expect("local agent lock");
        let Some(running) = slot.as_ref() else {
            return;
        };
        let mut core = running.core.lock().expect("local agent core");
        let Some(tx) = core.pending.remove(&id) else {
            return;
        };
        let decision = match status {
            "offered" => OfferDecision::Offered { from, to, revision },
            "stale" => OfferDecision::Stale,
            _ => OfferDecision::Unavailable,
        };
        let _ = tx.send(decision);
    }
}

fn info_of(running: &Running) -> StartInfo {
    StartInfo {
        port: running.port,
        token: running.token.clone(),
        origin: running.origin.clone(),
        discovery_path: running.discovery_path.clone(),
    }
}

fn apply_gate(core: &Arc<Mutex<Core>>, root: &str, denylist: &str) -> Result<(), String> {
    let (gate_root, rules) = parse_gate(root, denylist)?;
    let mut guard = core.lock().expect("local agent core");
    guard.root = gate_root;
    guard.denylist = rules;
    Ok(())
}

fn parse_gate(root: &str, denylist: &str) -> Result<(Option<PathBuf>, Vec<String>), String> {
    let root = root.trim();
    let gate_root = if root.is_empty() {
        None
    } else {
        let path = PathBuf::from(root);
        if !path.is_dir() {
            return Err("工作区不是文件夹。".to_string());
        }
        Some(
            path.canonicalize()
                .map_err(|error| format!("无法解析工作区：{error}"))?,
        )
    };
    Ok((gate_root, parse_denylist(denylist)))
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("无法生成令牌：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn discovery_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("local-agent.json"))
}

fn write_discovery(app: &AppHandle, origin: &str, token: &str) -> Option<String> {
    let path = discovery_file(app)?;
    let body = json!({ "version": 1, "origin": origin, "token": token });
    let mut file = fs::File::create(&path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file.write_all(body.to_string().as_bytes()).ok()?;
    Some(path.to_string_lossy().to_string())
}

fn spawn_detached<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let _: JoinHandle<()> = handle.spawn(future);
    } else {
        tauri::async_runtime::spawn(future);
    }
}

fn spawn_server(core: Arc<Mutex<Core>>, stop: watch::Receiver<bool>) -> std::io::Result<u16> {
    // Bind synchronously so callers get the port without blocking the runtime.
    // Converting to a Tokio listener happens inside the async task; doing it on
    // the command thread would require a reactor and used to panic.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    spawn_detached(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(_) => return,
        };
        let mut stop = stop;
        loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else { break };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let core = core.clone();
                    spawn_detached(async move {
                        let _ = handle_connection(stream, core).await;
                    });
                }
            }
        }
    });
    Ok(port)
}

async fn handle_connection(mut stream: TcpStream, core: Arc<Mutex<Core>>) -> std::io::Result<()> {
    let request = match tokio::time::timeout(Duration::from_secs(5), read_http(&mut stream)).await {
        Ok(Ok(request)) => request,
        _ => return Ok(()),
    };
    let response = respond(&request, &core).await;
    let _ = stream.write_all(&response).await;
    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    token: String,
    body: Vec<u8>,
}

async fn read_http(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "closed",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > HEADER_CAP + BODY_CAP {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "too large",
            ));
        }
        if let Some(index) = find_header_end(&buf) {
            break index;
        }
        if buf.len() > HEADER_CAP {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "headers",
            ));
        }
    };
    let header_bytes = buf[..header_end].to_vec();
    let header = String::from_utf8_lossy(&header_bytes);
    let mut lines = header.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut token = String::new();
    let mut length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("authorization") {
            token = bearer(value.trim());
        } else if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().unwrap_or(usize::MAX);
        }
    }
    if length > BODY_CAP {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body"));
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(length);
    Ok(HttpRequest {
        method,
        path,
        token,
        body,
    })
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn bearer(value: &str) -> String {
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .unwrap_or("")
        .trim()
        .to_string()
}

async fn respond(request: &HttpRequest, core: &Arc<Mutex<Core>>) -> Vec<u8> {
    let authorized = {
        let guard = core.lock().expect("local agent core");
        tokens_match(&guard.token, &request.token)
    };
    if !authorized {
        return http(401, &json!({ "error": "需要本机令牌。" }));
    }
    let path = request.path.split('?').next().unwrap_or("");
    let result = if request.method == "POST" && path == "/v1/candidate" {
        offer_candidate(core, &request.body).await
    } else if request.method == "POST" && path == "/v1/open" {
        open_document(core, &request.body).await
    } else {
        dispatch(request, core)
    };
    match result {
        Ok(body) => http(200, &body),
        Err(rejection) => http(rejection.status, &json!({ "error": rejection.message })),
    }
}

struct Rejection {
    status: u16,
    message: String,
}

fn reject(status: u16, message: impl Into<String>) -> Result<Value, Rejection> {
    Err(Rejection {
        status,
        message: message.into(),
    })
}

fn dispatch(request: &HttpRequest, core: &Arc<Mutex<Core>>) -> Result<Value, Rejection> {
    let path = request.path.split('?').next().unwrap_or("");
    match (request.method.as_str(), path) {
        ("GET", "/v1") => Ok(json!({
            "name": "6byte",
            "version": 1,
            "routes": [
                "GET /v1/editor",
                "GET /v1/workspace",
                "POST /v1/list_dir",
                "POST /v1/grep",
                "POST /v1/read_range",
                "POST /v1/outline",
                "POST /v1/find",
                "POST /v1/document",
                "POST /v1/open",
                "POST /v1/candidate"
            ]
        })),
        ("GET", "/v1/editor") => editor_view(core),
        ("GET", "/v1/workspace") => {
            let guard = core.lock().expect("local agent core");
            Ok(json!({
                "root": guard.root.as_ref().map(|path| display_path(path))
            }))
        }
        ("POST", "/v1/list_dir") => list_dir(core, &request.body),
        ("POST", "/v1/grep") => search(core, &request.body),
        ("POST", "/v1/read_range") => read_span(core, &request.body),
        ("POST", "/v1/outline") => outline_of(core, &request.body),
        ("POST", "/v1/find") => find_files(core, &request.body),
        ("POST", "/v1/document") => read_document(core, &request.body),
        _ => reject(404, "没有这个接口。"),
    }
}

fn editor_view(core: &Arc<Mutex<Core>>) -> Result<Value, Rejection> {
    let guard = core.lock().expect("local agent core");
    if blocked_editor(&guard) {
        return reject(403, "拒绝：当前文件是隐藏文件、密钥文件或在禁读名单里。");
    }
    Ok(editor_json(&guard.editor))
}

fn editor_json(editor: &EditorSnapshot) -> Value {
    json!({
        "path": display_path(Path::new(&editor.path)),
        "name": editor.name,
        "revision": editor.revision,
        "truncated": editor.truncated,
        "text": if editor.truncated { Value::Null } else { Value::String(editor.text.clone()) },
        "selection": {
            "from": editor.selection_from,
            "to": editor.selection_to,
            "text": editor.selection_text,
        }
    })
}

fn blocked_editor(core: &Core) -> bool {
    let Some(root) = core.root.as_ref() else {
        return false;
    };
    if core.editor.path.is_empty() {
        return false;
    }
    blocked(root, &core.denylist, Path::new(&core.editor.path))
}

fn list_dir(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let requested = json_path(body);
    let (root, denylist) = gate(core)?;
    let path = resolve(&root, &requested)?;
    if !path.is_dir() {
        return reject(400, "不是文件夹。");
    }
    let listed =
        list_dir_children(path.to_string_lossy().to_string()).map_err(|error| Rejection {
            status: 400,
            message: error,
        })?;
    let entries: Vec<_> = listed
        .entries
        .into_iter()
        .filter(|entry| !blocked(&root, &denylist, Path::new(&entry.path)))
        .map(|entry| json!({ "name": entry.name, "path": entry.path, "kind": entry.kind }))
        .collect();
    Ok(json!({ "entries": entries, "truncated": listed.truncated }))
}

fn search(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let value = parse_body(body)?;
    let pattern = value
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if pattern.is_empty() {
        return reject(400, "搜索内容不能为空。");
    }
    let requested = value
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (root, denylist) = gate(core)?;
    let path = resolve(&root, &requested)?;
    if blocked(&root, &denylist, &path) {
        return reject(403, "拒绝：这是隐藏文件、密钥文件或在禁读名单里。");
    }
    let found = grep::grep(&path, &pattern, false, Some(200)).map_err(|error| Rejection {
        status: 400,
        message: error,
    })?;
    let mut matches = Vec::new();
    for item in found.matches {
        if blocked(&root, &denylist, Path::new(&item.path)) {
            continue;
        }
        matches.push(json!({
            "path": display_path(Path::new(&item.path)),
            "line": item.line,
            "column": item.column,
            "text": item.text,
        }));
        if matches.len() >= GREP_CAP {
            break;
        }
    }
    Ok(json!({
        "matches": matches,
        "truncated": found.truncated || matches.len() >= GREP_CAP,
    }))
}

fn read_document(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let requested = json_path(body);
    if requested.trim().is_empty() {
        return reject(400, "需要一个文件路径。");
    }
    let (root, denylist) = gate(core)?;
    let path = resolve(&root, &requested)?;
    if blocked(&root, &denylist, &path) {
        return reject(403, "拒绝：这是隐藏文件、密钥文件或在禁读名单里。");
    }
    let file =
        commands::read_file(path.to_string_lossy().to_string()).map_err(|error| Rejection {
            status: 400,
            message: error,
        })?;
    if file.content.len() > DOCUMENT_CAP {
        return reject(400, "文件太大，read_document 只读取 2 MB 以内的文本。");
    }
    Ok(json!({
        "path": display_path(&path),
        "name": file.name,
        "text": file.content,
        "lines": file.content.lines().count(),
        "truncated": false,
    }))
}

fn find_files(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let value = parse_body(body)?;
    let pattern = value
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if pattern.is_empty() {
        return reject(400, "需要一个文件名模式，例如 *.md。");
    }
    let requested = value
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (root, denylist) = gate(core)?;
    let start = resolve(&root, &requested)?;
    if !start.is_dir() {
        return reject(400, "起点不是文件夹。");
    }
    if blocked(&root, &denylist, &start) {
        return reject(403, "拒绝：这是隐藏文件、密钥文件或在禁读名单里。");
    }
    let mut files = Vec::new();
    let mut truncated = false;
    collect_files(
        &start,
        &root,
        &denylist,
        &glob_regex(&pattern),
        &mut files,
        &mut truncated,
        0,
    );
    Ok(json!({ "files": files, "truncated": truncated }))
}

fn collect_files(
    dir: &Path,
    root: &Path,
    denylist: &[String],
    pattern: &regex::Regex,
    files: &mut Vec<Value>,
    truncated: &mut bool,
    depth: usize,
) {
    if *truncated || files.len() >= FIND_CAP {
        *truncated = true;
        return;
    }
    if depth > 32 {
        *truncated = true;
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *truncated || files.len() >= FIND_CAP {
            *truncated = true;
            return;
        }
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
        let path = entry.path();
        if blocked(root, denylist, &path) {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&path, root, denylist, pattern, files, truncated, depth + 1);
        } else if file_type.is_file() && pattern.is_match(&name) {
            files.push(json!({
                "path": display_path(&path),
                "name": name,
            }));
        }
    }
}

fn read_span(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let value = parse_body(body)?;
    let requested = value
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let start = value
        .get("start")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1);
    let mut end = value.get("end").and_then(Value::as_u64).unwrap_or(start);
    if end < start {
        end = start;
    }
    if end - start + 1 > READ_RANGE_CAP {
        end = start + READ_RANGE_CAP - 1;
    }
    let (root, denylist, editor) = {
        let guard = core.lock().expect("local agent core");
        let root = guard.root.clone().ok_or_else(|| Rejection {
            status: 400,
            message: "没有打开工作区。".to_string(),
        })?;
        (root, guard.denylist.clone(), guard.editor.clone())
    };
    let path = if requested.trim().is_empty() {
        if editor.path.is_empty() {
            return reject(409, "没有打开的文件。请带上 path。");
        }
        PathBuf::from(&editor.path)
    } else {
        resolve(&root, &requested)?
    };
    if blocked(&root, &denylist, &path) {
        return reject(403, "拒绝：这是隐藏文件、密钥文件或在禁读名单里。");
    }
    let same_editor = !editor.path.is_empty() && same_path(Path::new(&editor.path), &path);
    let text = if same_editor && !editor.truncated {
        editor.text
    } else {
        let file =
            commands::read_file(path.to_string_lossy().to_string()).map_err(|error| Rejection {
                status: 400,
                message: error,
            })?;
        if file.content.len() > 2 * 1024 * 1024 {
            return reject(400, "文件太大，本地 Agent 不读取超过 2 MB 的文件。");
        }
        file.content
    };
    let lines: Vec<&str> = text.lines().collect();
    let last = lines.len() as u64;
    let from = start.min(last.saturating_add(1));
    let to = end.min(last);
    let slice = if from == 0 || from > last {
        Vec::new()
    } else {
        lines[(from as usize - 1)..(to as usize).max(from as usize - 1)].to_vec()
    };
    Ok(json!({
        "path": display_path(&path),
        "start": from,
        "end": to,
        "text": slice.join("\n"),
    }))
}

fn outline_of(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let requested = json_path(body);
    let (root, denylist, editor) = {
        let guard = core.lock().expect("local agent core");
        let root = guard.root.clone().ok_or_else(|| Rejection {
            status: 400,
            message: "没有打开工作区。".to_string(),
        })?;
        (root, guard.denylist.clone(), guard.editor.clone())
    };
    let path = if requested.is_empty() {
        if editor.path.is_empty() {
            return reject(400, "没有打开的文件。");
        }
        PathBuf::from(&editor.path)
    } else {
        resolve(&root, &requested)?
    };
    if blocked(&root, &denylist, &path) {
        return reject(403, "拒绝：这是隐藏文件、密钥文件或在禁读名单里。");
    }
    let same_editor = !editor.path.is_empty() && same_path(Path::new(&editor.path), &path);
    let text = if same_editor && !editor.truncated {
        editor.text
    } else {
        commands::read_file(path.to_string_lossy().to_string())
            .map_err(|error| Rejection {
                status: 400,
                message: error,
            })?
            .content
    };
    Ok(json!({ "path": display_path(&path), "headings": markdown_outline(&text) }))
}

async fn offer_candidate(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let value = parse_body(body)?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.trim().is_empty() {
        return reject(400, "候选不能为空。不会写入文件。");
    }
    if text.len() > CANDIDATE_CAP {
        return reject(400, "候选太长。不会写入文件。");
    }
    let Some(revision) = value.get("revision").and_then(Value::as_u64) else {
        return reject(400, "候选需要带上修订号和范围。不会写入文件。");
    };
    let Some(from) = value.get("from").and_then(Value::as_u64) else {
        return reject(400, "候选需要带上修订号和范围。不会写入文件。");
    };
    let Some(to) = value.get("to").and_then(Value::as_u64) else {
        return reject(400, "候选需要带上修订号和范围。不会写入文件。");
    };
    if from > to {
        return reject(400, "候选范围不成立。不会写入文件。");
    }
    if from > u64::from(u32::MAX) || to > u64::from(u32::MAX) {
        return reject(400, "候选范围太大。不会写入文件。");
    }
    let from = from as u32;
    let to = to as u32;

    let (id, app, path, rx) = {
        let mut guard = core.lock().expect("local agent core");
        if blocked_editor(&guard) {
            return reject(403, "拒绝：当前文件是隐藏文件、密钥文件或在禁读名单里。");
        }
        if guard.editor.path.is_empty() {
            return reject(409, "没有打开的文件。候选不会写入文件。");
        }
        let Some(app) = guard.app.clone() else {
            return reject(409, "编辑器没有接上。候选不会写入文件。");
        };
        let path = guard.editor.path.clone();
        let id = guard.next_offer;
        guard.next_offer = guard.next_offer.wrapping_add(1);
        let (tx, rx) = oneshot::channel();
        guard.pending.insert(id, tx);
        (id, app, path, rx)
    };

    let _ = app.emit(
        "local-agent-candidate",
        CandidateEvent {
            id,
            path: path.clone(),
            revision,
            from,
            to,
            text,
        },
    );

    let decision = tokio::time::timeout(Duration::from_secs(5), rx).await;
    {
        let mut guard = core.lock().expect("local agent core");
        guard.pending.remove(&id);
    }
    match decision {
        Ok(Ok(OfferDecision::Offered { from, to, revision })) => Ok(json!({
            "status": "offered",
            "saved": false,
            "path": path,
            "from": from,
            "to": to,
            "revision": revision,
        })),
        Ok(Ok(OfferDecision::Stale)) => reject(409, "原文已经变动，这次改写已放弃。正文没有改动。"),
        Ok(Ok(OfferDecision::Unavailable)) => reject(409, "候选没有放进编辑器。正文没有改动。"),
        _ => reject(409, "编辑器没有确认这次候选。正文没有改动。"),
    }
}

async fn open_document(core: &Arc<Mutex<Core>>, body: &[u8]) -> Result<Value, Rejection> {
    let requested = json_path(body);
    if requested.trim().is_empty() {
        return reject(400, "需要一个文件路径。");
    }
    let (root, denylist) = gate(core)?;
    let path = resolve(&root, &requested)?;
    if blocked(&root, &denylist, &path) {
        return reject(403, "拒绝：路径是隐藏文件、密钥文件或在禁读名单里。");
    }
    if !path.is_file() {
        return reject(400, "路径不是文件。");
    }
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size > crate::bigfile::L2_MAX_BYTES {
        return reject(400, "文件太大，MCP 只能把可编辑的文本带进编辑器。");
    }
    let (app, display) = {
        let guard = core.lock().expect("local agent core");
        let Some(app) = guard.app.clone() else {
            return reject(409, "编辑器没有接上。");
        };
        (app, display_path(&path))
    };
    let _ = app.emit("local-agent-open", json!({ "path": display }));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        {
            let guard = core.lock().expect("local agent core");
            if !guard.editor.path.is_empty() && same_path(Path::new(&guard.editor.path), &path) {
                return Ok(editor_json(&guard.editor));
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    reject(409, "编辑器没有确认打开这个文件。")
}

fn gate(core: &Arc<Mutex<Core>>) -> Result<(PathBuf, Vec<String>), Rejection> {
    let guard = core.lock().expect("local agent core");
    let root = guard.root.clone().ok_or_else(|| Rejection {
        status: 400,
        message: "没有打开工作区。".to_string(),
    })?;
    Ok((root, guard.denylist.clone()))
}

fn json_path(body: &[u8]) -> String {
    parse_body(body)
        .ok()
        .and_then(|value| {
            value
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn parse_body(body: &[u8]) -> Result<Value, Rejection> {
    if body.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(body).map_err(|_| Rejection {
        status: 400,
        message: "请求不是 JSON。".to_string(),
    })
}

fn resolve(root: &Path, raw: &str) -> Result<PathBuf, Rejection> {
    let raw = raw.trim();
    let joined = if raw.is_empty() || raw == "." {
        root.to_path_buf()
    } else {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let canon = joined.canonicalize().map_err(|_| Rejection {
        status: 404,
        message: "路径不存在。".to_string(),
    })?;
    if !is_under(root, &canon) {
        return Err(Rejection {
            status: 403,
            message: "路径在工作区之外。".to_string(),
        });
    }
    Ok(canon)
}

fn is_under(root: &Path, path: &Path) -> bool {
    let root = unify(&root.to_string_lossy()).to_ascii_lowercase();
    let path = unify(&path.to_string_lossy()).to_ascii_lowercase();
    path == root || path.starts_with(&(root + "/"))
}

fn same_path(left: &Path, right: &Path) -> bool {
    plain(&left.to_string_lossy()) == plain(&right.to_string_lossy())
}

fn plain(value: &str) -> String {
    unify(value).to_ascii_lowercase()
}

/// Drop the Windows `\\?\` prefix so agents see the same path the editor uses.
fn display_path(path: &Path) -> String {
    let text = unify(&path.to_string_lossy());
    #[cfg(windows)]
    {
        text.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        text
    }
}

fn blocked(root: &Path, denylist: &[String], path: &Path) -> bool {
    let Some(segments) = segments_under(root, path) else {
        return true;
    };
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return true;
    }
    if segments.iter().any(|segment| secret_name(segment)) {
        return true;
    }
    denylist.iter().any(|rule| listed_by(rule, &segments))
}

fn segments_under(root: &Path, path: &Path) -> Option<Vec<String>> {
    let root = unify(&root.to_string_lossy());
    let full = unify(&path.to_string_lossy());
    let root_lower = root.to_ascii_lowercase();
    let full_lower = full.to_ascii_lowercase();
    if !full_lower.starts_with(&root_lower) {
        return None;
    }
    let rest = &full[root.len()..];
    if !rest.is_empty() && !rest.starts_with('/') {
        return None;
    }
    let segments: Vec<String> = rest
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .map(str::to_string)
        .collect();
    if segments.iter().any(|segment| segment == "..") {
        return None;
    }
    Some(segments)
}

fn unify(value: &str) -> String {
    let value = value.replace('\\', "/");
    let value = if let Some(rest) = value.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = value.strip_prefix("//?/") {
        rest.to_string()
    } else {
        value
    };
    value.trim_end_matches('/').to_string()
}

fn secret_name(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    if SECRET_KEY_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return true;
    }
    let (stem, extension) = match lower.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, extension),
        _ => (lower.as_str(), ""),
    };
    if !extension.is_empty() && SECRET_EXTENSIONS.contains(&extension) {
        return true;
    }
    SECRET_NAMES.contains(&stem)
        && matches!(
            extension,
            "" | "json" | "yaml" | "yml" | "toml" | "ini" | "txt" | "xml"
        )
}

fn listed_by(rule: &str, segments: &[String]) -> bool {
    let pattern = unify(rule)
        .trim_start_matches('/')
        .trim_start_matches("./")
        .to_string();
    if pattern.is_empty() {
        return false;
    }
    let regex = glob_regex(&pattern);
    if !pattern.contains('/') {
        return segments.iter().any(|segment| regex.is_match(segment));
    }
    for end in 1..=segments.len() {
        if regex.is_match(&segments[..end].join("/")) {
            return true;
        }
    }
    false
}

fn glob_regex(pattern: &str) -> regex::Regex {
    let mut out = String::from("(?i)^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if char == '*' {
            if chars.get(index + 1) == Some(&'*') {
                out.push_str(".*");
                index += 2;
            } else {
                out.push_str("[^/]*");
                index += 1;
            }
            continue;
        }
        if char == '?' {
            out.push_str("[^/]");
        } else {
            out.push_str(&regex::escape(&char.to_string()));
        }
        index += 1;
    }
    out.push('$');
    regex::Regex::new(&out).unwrap_or_else(|_| regex::Regex::new("$.^").expect("fallback"))
}

fn parse_denylist(raw: &str) -> Vec<String> {
    let mut rules = Vec::new();
    for line in raw.split(['\n', '\r']) {
        let rule = line.trim();
        if rule.is_empty() || rule.starts_with('#') {
            continue;
        }
        let clipped = rule.chars().take(200).collect::<String>();
        if !rules.contains(&clipped) {
            rules.push(clipped);
        }
        if rules.len() >= 100 {
            break;
        }
    }
    rules
}

fn markdown_outline(text: &str) -> Vec<Value> {
    let mut headings = Vec::new();
    let mut fence = false;
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        let hashes = trimmed.chars().take_while(|char| *char == '#').count();
        if !(1..=6).contains(&hashes) {
            continue;
        }
        let rest = trimmed[hashes..].trim();
        if rest.is_empty() || trimmed.as_bytes().get(hashes) == Some(&b'#') {
            continue;
        }
        headings.push(json!({
            "level": hashes,
            "text": rest,
            "line": index + 1,
        }));
    }
    headings
}

fn tokens_match(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    if expected.is_empty() || expected.len() != provided.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.iter().zip(provided) {
        diff |= left ^ right;
    }
    diff == 0
}

fn http(status: u16, body: &Value) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Error",
    };
    let payload = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    let mut bytes = head.into_bytes();
    bytes.extend(payload.into_bytes());
    bytes
}

/// Clamp a snapshot before it is stored. Oversized documents omit the body.
fn prepare_snapshot(
    path: String,
    name: String,
    revision: u64,
    text: String,
    selection_from: u32,
    selection_to: u32,
    selection_text: String,
) -> EditorSnapshot {
    let truncated = text.chars().count() > EDITOR_TEXT_CAP;
    let selection_text = selection_text.chars().take(SELECTION_CAP).collect();
    EditorSnapshot {
        path,
        name,
        revision,
        truncated,
        text: if truncated { String::new() } else { text },
        selection_from,
        selection_to,
        selection_text,
    }
}

#[tauri::command]
pub fn local_agent_start(
    app: AppHandle,
    agent: tauri::State<'_, LocalAgent>,
    root: String,
    denylist: String,
) -> Result<StartInfo, String> {
    agent.start(&app, root, denylist)
}

#[tauri::command]
pub fn local_agent_stop(app: AppHandle, agent: tauri::State<'_, LocalAgent>) {
    agent.stop(&app);
}

#[tauri::command]
pub fn local_agent_status(agent: tauri::State<'_, LocalAgent>) -> StatusInfo {
    agent.status()
}

#[tauri::command]
pub fn local_agent_set_gate(
    agent: tauri::State<'_, LocalAgent>,
    root: String,
    denylist: String,
) -> Result<(), String> {
    agent.set_gate(root, denylist)
}

#[tauri::command]
pub fn local_agent_resolve_candidate(
    agent: tauri::State<'_, LocalAgent>,
    id: u64,
    status: String,
    from: u32,
    to: u32,
    revision: u64,
) {
    agent.resolve_candidate(id, &status, from, to, revision);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorUpdate {
    path: String,
    name: String,
    revision: u64,
    text: String,
    selection_from: u32,
    selection_to: u32,
    selection_text: String,
}

#[tauri::command]
pub fn local_agent_set_editor(agent: tauri::State<'_, LocalAgent>, update: EditorUpdate) {
    agent.set_editor(prepare_snapshot(
        update.path,
        update.name,
        update.revision,
        update.text,
        update.selection_from,
        update.selection_to,
        update.selection_text,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn collect_files_skips_hidden_and_dependency_dirs() {
        let root = std::env::temp_dir().join(format!("6byte-find-{}", std::process::id()));
        let docs = root.join("docs");
        let deps = root.join("node_modules");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&deps).unwrap();
        fs::write(docs.join("a.md"), "# a").unwrap();
        fs::write(docs.join("b.txt"), "b").unwrap();
        fs::write(docs.join(".hidden.md"), "hidden").unwrap();
        fs::write(docs.join(".env"), "secret").unwrap();
        fs::write(deps.join("c.md"), "# c").unwrap();
        let canonical = root.canonicalize().unwrap();
        let mut files = Vec::new();
        let mut truncated = false;
        collect_files(
            &canonical,
            &canonical,
            &[],
            &glob_regex("*.md"),
            &mut files,
            &mut truncated,
            0,
        );
        let names: Vec<String> = files
            .iter()
            .filter_map(|file| file.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(names, vec!["a.md"]);
        assert!(!truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn token_compare_rejects_a_different_value() {
        assert!(tokens_match("abcd", "abcd"));
        assert!(!tokens_match("abcd", "abce"));
        assert!(!tokens_match("abcd", "abc"));
        assert!(!tokens_match("", ""));
    }

    #[test]
    fn outline_skips_a_fence_and_reads_atx_headings() {
        let text = "# Title\n\n```\n# not a heading\n```\n\n## Next\n";
        let headings = markdown_outline(text);
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0]["text"], "Title");
        assert_eq!(headings[1]["line"], 7);
    }

    #[test]
    fn secret_and_hidden_paths_are_blocked() {
        let root = std::env::temp_dir();
        let denylist = vec!["private/**".to_string()];
        let secret = root.join("notes").join(".env");
        let hidden = root.join(".git").join("config");
        let listed = root.join("private").join("note.md");
        let open = root.join("notes").join("post.md");
        assert!(blocked(&root, &denylist, &secret));
        assert!(blocked(&root, &denylist, &hidden));
        assert!(blocked(&root, &denylist, &listed));
        assert!(!blocked(&root, &denylist, &open));
        assert!(blocked(&root, &denylist, Path::new("/etc/passwd")));
    }

    #[test]
    #[cfg(windows)]
    fn verbatim_prefix_still_sees_a_normal_child() {
        let root = Path::new(r"\\?\D:\docs");
        let child = Path::new(r"D:\docs\note.md");
        let hidden = Path::new(r"D:\docs\.git\config");
        let outside = Path::new(r"E:\docs\note.md");
        assert!(is_under(root, child));
        assert!(!blocked(root, &[], child));
        assert!(blocked(root, &[], hidden));
        assert!(blocked(root, &[], outside));
        assert_eq!(display_path(root), r"D:\docs");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\srv\share\a.md")),
            r"\\srv\share\a.md"
        );
    }

    #[test]
    fn oversized_editor_text_is_omitted() {
        let snapshot = prepare_snapshot(
            "a.md".into(),
            "a.md".into(),
            3,
            "x".repeat(EDITOR_TEXT_CAP + 1),
            1,
            2,
            "hi".into(),
        );
        assert!(snapshot.truncated);
        assert!(snapshot.text.is_empty());
        assert_eq!(snapshot.selection_text, "hi");
    }

    async fn boot(token: &str) -> (u16, Arc<Mutex<Core>>) {
        let core = Arc::new(Mutex::new(Core {
            token: token.to_string(),
            root: None,
            denylist: Vec::new(),
            app: None,
            editor: EditorSnapshot {
                path: "C:/notes/post.md".into(),
                name: "post.md".into(),
                revision: 2,
                truncated: false,
                text: "# Hello\n\nbody".into(),
                selection_from: 8,
                selection_to: 12,
                selection_text: "body".into(),
            },
            next_offer: 1,
            pending: HashMap::new(),
        }));
        let (tx, rx) = watch::channel(false);
        let port = spawn_server(core.clone(), rx).expect("bind");
        // Keep the stop sender alive for the duration of the test process;
        // dropping it makes `stop.changed()` return and the server exits
        // before the first request.
        std::mem::forget(tx);
        (port, core)
    }

    async fn exchange(port: u16, raw: &str) -> String {
        let mut stream = None;
        for _ in 0..30 {
            match TcpStream::connect(("127.0.0.1", port)).await {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        let mut stream = stream.expect("server");
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).to_string()
    }

    #[tokio::test]
    async fn missing_or_wrong_token_is_rejected_and_write_is_absent() {
        let token = "0123456789abcdef0123456789abcdef";
        let (port, _) = boot(token).await;
        let missing = exchange(port, "GET /v1/editor HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(missing.starts_with("HTTP/1.1 401"));
        let wrong = exchange(
            port,
            "GET /v1/editor HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer nope\r\n\r\n",
        )
        .await;
        assert!(wrong.starts_with("HTTP/1.1 401"));
        let write = exchange(
            port,
            &format!(
                "POST /v1/write_file HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
            ),
        )
        .await;
        assert!(write.starts_with("HTTP/1.1 404"));
        let editor = exchange(
            port,
            &format!("GET /v1/editor HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\r\n"),
        )
        .await;
        assert!(editor.starts_with("HTTP/1.1 200"));
        assert!(editor.contains("\"text\":\"# Hello\\n\\nbody\""));
        assert!(!editor.contains("\"saved\""));
    }

    #[tokio::test]
    async fn candidate_without_a_revision_does_not_write() {
        let token = "0123456789abcdef0123456789abcdef";
        let (port, _) = boot(token).await;
        let response = exchange(
            port,
            &format!(
                "POST /v1/candidate HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Length: 13\r\n\r\n{{\"text\":\"hi\"}}"
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 400"));
        assert!(response.contains("不会写入文件"));
    }

    #[tokio::test]
    async fn candidate_without_an_editor_does_not_wait_or_save() {
        let token = "0123456789abcdef0123456789abcdef";
        let (port, _) = boot(token).await;
        let body = r#"{"text":"hi","revision":2,"from":8,"to":12}"#;
        let response = exchange(
            port,
            &format!(
                "POST /v1/candidate HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 409"));
        assert!(response.contains("编辑器没有接上"));
        assert!(response.contains("不会写入文件"));
    }

    #[test]
    fn listener_is_loopback() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(listener.local_addr().unwrap().ip().is_loopback());
    }
}
