//! MCP stdio server for the running 6byte editor.
//!
//! Agents spawn this process. It reads `%APPDATA%\dev.aneditor.app\local-agent.json`
//! (or `SIXBYTE_AGENT_FILE`) and forwards tool calls to the loopback API.
//! It does not read or write the workspace itself.

use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

const KNOWN_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const BODY_CAP: usize = 8 * 1024 * 1024;

struct Discovery {
    port: u16,
    token: String,
}

trait AgentApi {
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String>;
}

struct LiveApi;

impl AgentApi for LiveApi {
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let discovery = load_discovery()?;
        http_exchange(&discovery, method, path, body)
    }
}

pub fn serve() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = io::BufReader::new(stdin.lock());
    let mut output = io::stdout().lock();
    let api = LiveApi;
    eprintln!("6byte-mcp: waiting");
    loop {
        match read_message(&mut input) {
            Ok(Some((message, frame))) => {
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    eprintln!("6byte-mcp: {method}");
                }
                if let Some(response) = handle_rpc(&message, &api) {
                    write_message(&mut output, &response, frame)?;
                }
            }
            Ok(None) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                eprintln!("6byte-mcp: {error}");
            }
            Err(error) => return Err(error),
        }
    }
}

fn handle_rpc(message: &Value, api: &dyn AgentApi) -> Option<Value> {
    let id = message.get("id")?;
    if id.is_null() {
        return None;
    }
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params");
    let result = match method {
        "initialize" => Ok(initialize_result(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => Ok(call_tool(params, api)),
        _ => Err(json!({ "code": -32601, "message": "方法不存在。" })),
    };
    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|value| value.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let protocol = if requested.is_empty() {
        "2024-11-05".to_string()
    } else if KNOWN_VERSIONS.contains(&requested) || looks_like_protocol(requested) {
        requested.to_string()
    } else {
        "2024-11-05".to_string()
    };
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "6byte", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "这些工具面向 6byte 里打开的那份文档。propose_edit 必须带上 get_editor 的 revision 和字符偏移 from/to。它只提交候选，saved 为 false；人在范围内改过字时调用失败，正文不变。"
    })
}

fn tool_list() -> Vec<Value> {
    vec![
        tool(
            "get_editor",
            "读取 6byte 当前打开的文档、修订号和选区。text 是未保存的正文。propose_edit 必须使用同一次结果里的 revision。from/to 是字符偏移，不是行号。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "get_workspace",
            "读取当前工作区根目录。没有打开工作区时 root 为空。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "list_dir",
            "列出工作区里的一层目录。path 省略时列根目录。隐藏文件、密钥文件和禁读名单不会出现。",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "相对工作区的目录，省略表示根" } },
                "additionalProperties": false
            }),
        ),
        tool(
            "grep",
            "在工作区里搜索纯文本。结果最多 40 条。",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "相对工作区的起点，省略表示根" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        tool(
            "read_range",
            "按从 1 开始的行号读取文件，一次最多 80 行。当前打开的文件读未保存正文。",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "start": { "type": "integer", "minimum": 1 },
                    "end": { "type": "integer", "minimum": 1 }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        ),
        tool(
            "outline",
            "读取 Markdown 标题大纲。path 省略时用当前打开的文件。代码围栏里的标题不算。",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "additionalProperties": false
            }),
        ),
        tool(
            "propose_edit",
            "把一段替换交给当前文档审阅。revision、from、to 必须来自同一次 get_editor。人在范围内改过字时失败，正文不变；人在范围外打字时，编辑器挪到新位置再显示。接受前不会写入，saved 恒为 false。不要用写文件代替这个工具。",
            json!({
                "type": "object",
                "properties": {
                    "revision": { "type": "integer", "minimum": 0, "description": "get_editor 返回的 revision" },
                    "from": { "type": "integer", "minimum": 0 },
                    "to": { "type": "integer", "minimum": 0 },
                    "text": { "type": "string", "description": "用来替换 from..to 的正文" }
                },
                "required": ["revision", "from", "to", "text"],
                "additionalProperties": false
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema
    })
}

fn call_tool(params: Option<&Value>, api: &dyn AgentApi) -> Value {
    let name = params
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let arguments = params
        .and_then(|value| value.get("arguments"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "get_editor" => api.call("GET", "/v1/editor", None),
        "get_workspace" => api.call("GET", "/v1/workspace", None),
        "list_dir" => api.call(
            "POST",
            "/v1/list_dir",
            Some(&json!({ "path": arguments.get("path").and_then(Value::as_str).unwrap_or("") })),
        ),
        "grep" => match required_str(&arguments, "pattern") {
            Ok(pattern) => api.call(
                "POST",
                "/v1/grep",
                Some(&json!({
                    "pattern": pattern,
                    "path": arguments.get("path").and_then(Value::as_str).unwrap_or("")
                })),
            ),
            Err(message) => Err(message),
        },
        "read_range" => match required_str(&arguments, "path") {
            Ok(path) => {
                let mut body = json!({ "path": path });
                if let Some(start) = arguments.get("start").and_then(Value::as_u64) {
                    body["start"] = json!(start);
                }
                if let Some(end) = arguments.get("end").and_then(Value::as_u64) {
                    body["end"] = json!(end);
                }
                api.call("POST", "/v1/read_range", Some(&body))
            }
            Err(message) => Err(message),
        },
        "outline" => api.call(
            "POST",
            "/v1/outline",
            Some(&json!({ "path": arguments.get("path").and_then(Value::as_str).unwrap_or("") })),
        ),
        "propose_edit" => propose(&arguments, api),
        "" => Err("缺少工具名。".to_string()),
        other => Err(format!("没有这个工具：{other}")),
    };
    match result {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }]
        }),
        Err(message) => json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        }),
    }
}

fn propose(arguments: &Value, api: &dyn AgentApi) -> Result<Value, String> {
    let revision = required_u64(arguments, "revision")?;
    let from = required_u64(arguments, "from")?;
    let to = required_u64(arguments, "to")?;
    let text = required_str(arguments, "text")?;
    if text.trim().is_empty() {
        return Err("候选不能为空。不会写入文件。".to_string());
    }
    if from >= to {
        return Err("候选范围是空的。不会写入文件。".to_string());
    }
    api.call(
        "POST",
        "/v1/candidate",
        Some(&json!({
            "revision": revision,
            "from": from,
            "to": to,
            "text": text
        })),
    )
}

fn required_str(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("缺少 {key}。"))
}

fn required_u64(arguments: &Value, key: &str) -> Result<u64, String> {
    arguments
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} 要是非负整数。"))
}

fn load_discovery() -> Result<Discovery, String> {
    let path = discovery_path().ok_or_else(unavailable)?;
    let text = fs::read_to_string(&path).map_err(|_| unavailable())?;
    let value: Value = serde_json::from_str(&text).map_err(|_| unreadable())?;
    let origin = value.get("origin").and_then(Value::as_str).unwrap_or("");
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if token.is_empty() {
        return Err(unreadable());
    }
    let port = endpoint_port(origin)?;
    Ok(Discovery { port, token })
}

fn unavailable() -> String {
    "没有找到本机接口。请在 6byte 的设置 → 访问限制里打开「允许本机程序访问」。".to_string()
}

fn unreadable() -> String {
    "发现文件无法读取。请重新打开「允许本机程序访问」。".to_string()
}

fn discovery_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SIXBYTE_AGENT_FILE") {
        return Some(PathBuf::from(path));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")?;
        return Some(
            PathBuf::from(base)
                .join("dev.aneditor.app")
                .join("local-agent.json"),
        );
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library/Application Support/dev.aneditor.app/local-agent.json"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })?;
        return Some(base.join("dev.aneditor.app").join("local-agent.json"));
    }
    #[allow(unreachable_code)]
    None
}

fn endpoint_port(origin: &str) -> Result<u16, String> {
    let Some(rest) = origin.strip_prefix("http://") else {
        return Err("只接受本机地址。".to_string());
    };
    let rest = rest.trim_end_matches('/');
    let Some((host, port)) = rest.split_once(':') else {
        return Err("只接受本机地址。".to_string());
    };
    if host != "127.0.0.1" && host != "localhost" {
        return Err("只接受本机地址。".to_string());
    }
    let port: u16 = port.parse().map_err(|_| "只接受本机地址。".to_string())?;
    if port == 0 {
        return Err("只接受本机地址。".to_string());
    }
    Ok(port)
}

fn http_exchange(
    discovery: &Discovery,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let payload = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| unreadable())?;
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n",
        discovery.port, discovery.token
    );
    if let Some(payload) = &payload {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    request.push_str("\r\n");

    let address = SocketAddr::from(([127, 0, 0, 1], discovery.port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| unavailable())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|_| unavailable())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| unavailable())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|_| unavailable())?;
    if let Some(payload) = &payload {
        stream.write_all(payload).map_err(|_| unavailable())?;
    }

    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let read = stream.read(&mut tmp).map_err(|_| unavailable())?;
        if read == 0 {
            break;
        }
        if buf.len() + read > BODY_CAP {
            return Err("编辑器的响应太大。".to_string());
        }
        buf.extend_from_slice(&tmp[..read]);
    }
    parse_http(&buf)
}

fn parse_http(bytes: &[u8]) -> Result<Value, String> {
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(unavailable)?;
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(unavailable)?;
    let body = &bytes[header_end + 4..];
    let value: Value = serde_json::from_slice(body).map_err(|_| unavailable())?;
    if (200..300).contains(&status) {
        return Ok(value);
    }
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("编辑器拒绝了这次调用。");
    Err(message.to_string())
}

fn looks_like_protocol(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Frame {
    Headers,
    Lines,
}

fn read_message(input: &mut impl BufRead) -> io::Result<Option<(Value, Frame)>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        let read = input.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']).trim();
        if trimmed.is_empty() {
            break;
        }
        if trimmed.starts_with('{') {
            let value = serde_json::from_str(trimmed)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "json"))?;
            return Ok(Some((value, Frame::Lines)));
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let Some(length) = length else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "missing Content-Length",
        ));
    };
    if length > BODY_CAP {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut buf = vec![0u8; length];
    input.read_exact(&mut buf)?;
    match serde_json::from_slice(&buf) {
        Ok(value) => Ok(Some((value, Frame::Headers))),
        Err(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "json")),
    }
}

fn write_message(output: &mut impl Write, payload: &Value, frame: Frame) -> io::Result<()> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    match frame {
        Frame::Lines => {
            output.write_all(&bytes)?;
            output.write_all(b"\n")?;
        }
        Frame::Headers => {
            write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
            output.write_all(&bytes)?;
        }
    }
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Scripted {
        result: Result<Value, String>,
        calls: Mutex<Vec<(String, String, Option<Value>)>>,
    }

    impl AgentApi for Scripted {
        fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
            self.calls.lock().expect("calls").push((
                method.to_string(),
                path.to_string(),
                body.cloned(),
            ));
            self.result.clone()
        }
    }

    #[test]
    fn framing_round_trip() {
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        let mut bytes = Vec::new();
        write_message(&mut bytes, &payload, Frame::Headers).unwrap();
        let mut reader = io::Cursor::new(bytes);
        let (read, frame) = read_message(&mut reader).unwrap().unwrap();
        assert_eq!(frame, Frame::Headers);
        assert_eq!(read["method"], "ping");
    }

    #[test]
    fn newline_messages_round_trip_and_keep_the_clients_protocol() {
        let raw = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}\n";
        let (message, frame) = read_message(&mut io::Cursor::new(&raw[..]))
            .unwrap()
            .unwrap();
        assert_eq!(frame, Frame::Lines);
        let api = Scripted {
            result: Ok(json!({})),
            calls: Mutex::new(Vec::new()),
        };
        let response = handle_rpc(&message, &api).unwrap();
        let mut out = Vec::new();
        write_message(&mut out, &response, Frame::Lines).unwrap();
        assert!(out.ends_with(b"\n"));
        assert!(!String::from_utf8_lossy(&out).contains("Content-Length"));
        let parsed: Value =
            serde_json::from_str(std::str::from_utf8(&out).unwrap().trim()).unwrap();
        assert_eq!(parsed["result"]["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn initialize_echoes_a_known_version_and_lists_propose() {
        let api = Scripted {
            result: Ok(json!({})),
            calls: Mutex::new(Vec::new()),
        };
        let response = handle_rpc(
            &json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "initialize",
                "params": { "protocolVersion": "2025-06-18" }
            }),
            &api,
        )
        .unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        let listed = handle_rpc(
            &json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/list" }),
            &api,
        )
        .unwrap();
        let names: Vec<_> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(names.contains(&"propose_edit"));
        assert!(names.contains(&"get_editor"));
        assert!(handle_rpc(&json!({ "method": "notifications/initialized" }), &api).is_none());
    }

    #[test]
    fn propose_edit_forwards_the_revision_and_does_not_claim_a_save() {
        let api = Scripted {
            result: Ok(
                json!({ "status": "offered", "saved": false, "from": 8, "to": 13, "revision": 4 }),
            ),
            calls: Mutex::new(Vec::new()),
        };
        let response = handle_rpc(
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "propose_edit",
                    "arguments": { "revision": 2, "from": 6, "to": 11, "text": "next" }
                }
            }),
            &api,
        )
        .unwrap();
        assert!(response.get("error").is_none());
        assert!(response["result"].get("isError").is_none());
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"saved\":false"));
        let calls = api.calls.lock().unwrap();
        assert_eq!(calls[0].0, "POST");
        assert_eq!(calls[0].1, "/v1/candidate");
        assert_eq!(calls[0].2.as_ref().unwrap()["revision"], 2);
    }

    #[test]
    fn propose_edit_without_a_revision_does_not_call_the_editor() {
        let api = Scripted {
            result: Ok(json!({})),
            calls: Mutex::new(Vec::new()),
        };
        let response = handle_rpc(
            &json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": { "name": "propose_edit", "arguments": { "text": "next" } }
            }),
            &api,
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert!(api.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn editor_errors_stay_tool_errors() {
        let api = Scripted {
            result: Err("原文已经变动，这次改写已放弃。正文没有改动。".to_string()),
            calls: Mutex::new(Vec::new()),
        };
        let response = handle_rpc(
            &json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "propose_edit",
                    "arguments": { "revision": 1, "from": 0, "to": 4, "text": "next" }
                }
            }),
            &api,
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert!(response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("正文没有改动"));
    }

    #[test]
    fn origin_must_be_loopback() {
        assert_eq!(endpoint_port("http://127.0.0.1:9").unwrap(), 9);
        assert_eq!(endpoint_port("http://localhost:58890").unwrap(), 58890);
        assert!(endpoint_port("http://10.0.0.8:9").is_err());
        assert!(endpoint_port("https://127.0.0.1:9").is_err());
        assert!(endpoint_port("http://127.0.0.1:0").is_err());
    }

    #[test]
    fn http_error_body_is_the_message() {
        let raw = b"HTTP/1.1 409 Conflict\r\nContent-Length: 20\r\n\r\n{\"error\":\"stale\"}";
        let error = parse_http(raw).unwrap_err();
        assert_eq!(error, "stale");
    }
}
