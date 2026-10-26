//! Provider abstraction for M3. One OpenAI-compatible streaming client covers
//! hosted gateways and Ollama's `/v1` endpoint. The document is never written
//! here: callers receive `ai-token` / `ai-done` / `ai-error` and decide later.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::secrets::{resolve_key, AiSecrets};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PROVIDER_ID: &str = "openai-compatible";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// Incremental events a provider pushes while a request is open.
#[derive(Debug)]
pub enum StreamEvent {
    /// Answer text. This is what can be written into the document.
    Delta(String),
    /// Chain-of-thought text. Shown beside the input, never written.
    Reasoning(String),
    Done(Option<TokenUsage>),
}

#[derive(Debug)]
pub enum ProviderError {
    Cancelled,
    /// Non-2xx HTTP status. `detail` is already a short user-facing fragment.
    Http {
        status: u16,
        detail: String,
    },
    Network(String),
    Protocol(String),
    Upstream(String),
    Invalid(String),
    Timeout,
    /// 401/403 on the edit path. Not retried.
    Unauthorized,
    /// Edit path: no event arrived before the first-token deadline.
    FirstToken,
}

impl ProviderError {
    fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Http { .. } => "http",
            Self::Network(_) => "network",
            Self::Protocol(_) => "protocol",
            Self::Upstream(_) => "upstream",
            Self::Invalid(_) => "invalid",
            Self::Timeout => "timeout",
            Self::Unauthorized => "http",
            Self::FirstToken => "timeout",
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Cancelled => "已取消。".to_string(),
            Self::Http { status, detail } => format!("服务返回 {status}：{detail}"),
            Self::Network(detail) => format!("无法连接模型服务：{detail}"),
            Self::Protocol(detail) => format!("模型响应无法解析：{detail}"),
            Self::Upstream(detail) => format!("模型服务错误：{detail}"),
            Self::Invalid(detail) => detail.clone(),
            Self::Timeout => "等待模型响应超时。".to_string(),
            Self::Unauthorized => "密钥无效或没有权限。".to_string(),
            Self::FirstToken => {
                "15 秒内没有收到模型的第一个字，已取消。可以改用本地模型。".to_string()
            }
        }
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;

    async fn stream(
        &self,
        request: ChatRequest,
        sink: mpsc::Sender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<(), ProviderError>;
}

/// OpenAI `/v1/chat/completions` with `stream: true`.
#[derive(Clone)]
pub struct OpenAiCompatible {
    client: reqwest::Client,
    endpoint: String,
    api_key: Option<String>,
}

impl OpenAiCompatible {
    fn new(base_url: &str, api_key: Option<String>) -> Result<Self, ProviderError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .tcp_nodelay(true)
            .build()
            .map_err(|error| ProviderError::Network(error.to_string()))?;
        Ok(Self {
            client,
            endpoint: chat_completions_url(base_url)?,
            api_key: blank_to_none(api_key),
        })
    }
}

#[async_trait]
impl Provider for OpenAiCompatible {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    async fn stream(
        &self,
        request: ChatRequest,
        sink: mpsc::Sender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<(), ProviderError> {
        self.send(request, &sink, &cancel, true).await
    }
}

impl OpenAiCompatible {
    async fn send(
        &self,
        mut request: ChatRequest,
        sink: &mpsc::Sender<StreamEvent>,
        cancel: &CancellationToken,
        mut retry: bool,
    ) -> Result<(), ProviderError> {
        let response = loop {
            let mut builder = self
                .client
                .post(&self.endpoint)
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .json(&request_body(&request));
            if let Some(key) = &self.api_key {
                builder = builder.bearer_auth(key);
            }

            let response = tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                response = builder.send() => response.map_err(|error| ProviderError::Network(error.to_string()))?,
            };

            if response.status().is_success() {
                break response;
            }
            let status = response.status().as_u16();
            let detail = http_error_detail(response).await;
            if retry {
                if let Some(next) = without_rejected_parameters(&request, &detail) {
                    request = next;
                    retry = false;
                    continue;
                }
            }
            return Err(ProviderError::Http { status, detail });
        };

        let mut events = response.bytes_stream().eventsource();
        let mut usage = None;
        loop {
            let item = tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                item = events.next() => item,
            };
            let Some(item) = item else {
                break;
            };
            let event = item.map_err(|error| ProviderError::Protocol(error.to_string()))?;
            let data = event.data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                return send_event(sink, StreamEvent::Done(usage)).await;
            }
            let chunk = interpret_chunk(data)?;
            if let Some(next) = chunk.usage {
                usage = Some(next);
            }
            if !chunk.reasoning.is_empty()
                && send_event(sink, StreamEvent::Reasoning(chunk.reasoning))
                    .await
                    .is_err()
            {
                return Err(ProviderError::Cancelled);
            }
            if !chunk.content.is_empty()
                && send_event(sink, StreamEvent::Delta(chunk.content))
                    .await
                    .is_err()
            {
                return Err(ProviderError::Cancelled);
            }
        }
        send_event(sink, StreamEvent::Done(usage)).await
    }
}

struct Chunk {
    content: String,
    reasoning: String,
    usage: Option<TokenUsage>,
}

fn interpret_chunk(data: &str) -> Result<Chunk, ProviderError> {
    let value: Value =
        serde_json::from_str(data).map_err(|error| ProviderError::Protocol(error.to_string()))?;
    if let Some(detail) = upstream_error(&value) {
        return Err(ProviderError::Upstream(detail));
    }
    let (reasoning, content) = chunk_parts(&value);
    Ok(Chunk {
        content,
        reasoning,
        usage: token_usage(&value),
    })
}

/// Split one chunk into thinking and answer. Thinking models send
/// `reasoning_content` while `content` is null; some gateways send `content`
/// as an array of text parts. A later `message` object is used only when the
/// delta carried neither.
fn chunk_parts(value: &Value) -> (String, String) {
    for pointer in ["/choices/0/delta", "/choices/0/message"] {
        let Some(message) = value.pointer(pointer) else {
            continue;
        };
        let mut reasoning = String::new();
        let mut content = String::new();
        append_model_text(
            &mut reasoning,
            message
                .get("reasoning_content")
                .or_else(|| message.get("reasoning")),
        );
        append_model_text(&mut content, message.get("content"));
        if !reasoning.is_empty() || !content.is_empty() {
            return (reasoning, content);
        }
    }
    (String::new(), String::new())
}

fn append_model_text(out: &mut String, value: Option<&Value>) {
    match value {
        Some(Value::String(text)) => out.push_str(text),
        Some(Value::Array(parts)) => {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    out.push_str(text);
                } else if let Some(text) = part.as_str() {
                    out.push_str(text);
                }
            }
        }
        _ => {}
    }
}

fn upstream_error(value: &Value) -> Option<String> {
    match value.get("error")? {
        Value::String(message) => Some(message.clone()),
        Value::Object(_) => Some(
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("请求被拒绝")
                .to_string(),
        ),
        _ => Some("请求被拒绝".to_string()),
    }
}

fn token_usage(value: &Value) -> Option<TokenUsage> {
    let usage = value.get("usage")?;
    Some(TokenUsage {
        prompt_tokens: usage.get("prompt_tokens").and_then(Value::as_u64)?,
        completion_tokens: usage.get("completion_tokens").and_then(Value::as_u64)?,
    })
}

fn request_body(request: &ChatRequest) -> Value {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect();
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
    });
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    body
}

/// Ollama's `auto` router answers 400 with "does not support parameter(s): temperature".
/// Drop only the named fields that this request actually sent, and only once.
fn without_rejected_parameters(request: &ChatRequest, detail: &str) -> Option<ChatRequest> {
    let names = rejected_parameter_names(detail);
    if names.is_empty() {
        return None;
    }
    let mut next = request.clone();
    let mut changed = false;
    if names.iter().any(|name| name == "temperature") && next.temperature.take().is_some() {
        changed = true;
    }
    if names.iter().any(|name| name == "max_tokens") && next.max_tokens.take().is_some() {
        changed = true;
    }
    changed.then_some(next)
}

fn rejected_parameter_names(detail: &str) -> Vec<String> {
    let mut names = Vec::new();
    let marker = "parameter(s):";
    if let Some(index) = detail.find(marker) {
        names.extend(
            detail[index + marker.len()..]
                .split([';', '.'])
                .next()
                .unwrap_or("")
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
                .filter(|name| !name.is_empty()),
        );
    }
    let lower = detail.to_ascii_lowercase();
    for name in ["temperature", "max_tokens"] {
        if names.iter().any(|item| item == name) {
            continue;
        }
        if lower.contains(&format!("unsupported parameter: '{name}'"))
            || lower.contains(&format!("unsupported parameter: \"{name}\""))
        {
            names.push(name.to_string());
        }
    }
    names
}

async fn send_event(
    sink: &mpsc::Sender<StreamEvent>,
    event: StreamEvent,
) -> Result<(), ProviderError> {
    sink.send(event).await.map_err(|_| ProviderError::Cancelled)
}

async fn http_error_detail(response: reqwest::Response) -> String {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while bytes.len() < 2048 {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let Ok(chunk) = chunk else {
            break;
        };
        let room = 2048 - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
    let text = String::from_utf8_lossy(&bytes);
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(detail) = upstream_error(&value) {
            return detail;
        }
    }
    if trimmed.is_empty() {
        "请求被拒绝".to_string()
    } else {
        trimmed.chars().take(300).collect()
    }
}

fn chat_completions_url(base_url: &str) -> Result<String, ProviderError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(ProviderError::Invalid("服务地址无效。".to_string()));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| ProviderError::Invalid("服务地址无效。".to_string()))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ProviderError::Invalid(
            "服务地址只支持 http 或 https。".to_string(),
        ));
    }
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn validate_request(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Result<(), ProviderError> {
    if model.trim().is_empty() {
        return Err(ProviderError::Invalid("模型名称不能为空。".to_string()));
    }
    if messages.is_empty() {
        return Err(ProviderError::Invalid("消息不能为空。".to_string()));
    }
    for message in messages {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
            return Err(ProviderError::Invalid(format!(
                "不支持的消息角色：{}",
                message.role
            )));
        }
    }
    if let Some(temperature) = temperature {
        if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
            return Err(ProviderError::Invalid(
                "温度必须在 0 到 2 之间。".to_string(),
            ));
        }
    }
    if max_tokens == Some(0) {
        return Err(ProviderError::Invalid("生成长度必须大于 0。".to_string()));
    }
    Ok(())
}

/// In-flight streams. Cancelling removes the token and aborts the HTTP body.
#[derive(Clone, Default)]
pub struct AiHub {
    next: Arc<AtomicU64>,
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl AiHub {
    fn alloc_id(&self) -> String {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        format!("ai-{id}")
    }

    fn track(&self, stream_id: &str, cancel: CancellationToken) {
        lock(&self.active).insert(stream_id.to_string(), cancel);
    }

    fn finish(&self, stream_id: &str) {
        lock(&self.active).remove(stream_id);
    }

    /// Returns whether a live request was cancelled. A finished id is a no-op.
    pub fn cancel(&self, stream_id: &str) -> bool {
        let Some(token) = lock(&self.active).remove(stream_id) else {
            return false;
        };
        token.cancel();
        true
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiToken {
    stream_id: String,
    delta: String,
    /// `content` is the rewrite. `reasoning` is the thinking trace.
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiDone {
    stream_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<TokenUsage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiError {
    stream_id: String,
    code: String,
    message: String,
}

#[derive(Clone, Copy)]
struct EditPolicy {
    first_token: Duration,
    /// Delays before each retry. Two entries means two retries after the first failure.
    retries: &'static [Duration],
}

const EDIT_FIRST_TOKEN: Duration = Duration::from_secs(15);
const EDIT_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(400), Duration::from_millis(800)];

fn edit_policy() -> EditPolicy {
    EditPolicy {
        first_token: EDIT_FIRST_TOKEN,
        retries: &EDIT_RETRY_DELAYS,
    }
}

fn retryable_status(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::Http { status, .. } if *status == 429 || (500..600).contains(status)
    )
}

fn explain_edit_error(error: ProviderError) -> ProviderError {
    match error {
        ProviderError::Http {
            status: 401 | 403, ..
        } => ProviderError::Unauthorized,
        other => other,
    }
}

/// Edit-path wrapper around `stream`. The probe does not use this: it keeps its own
/// overall deadline and does not back off. 429 and 5xx retry twice. 401/403 do not.
/// The first-token timer stops once any event arrives, so a long reply is not cut off.
async fn run_edit_stream(
    provider: &impl Provider,
    request: ChatRequest,
    sink: mpsc::Sender<StreamEvent>,
    cancel: CancellationToken,
    policy: EditPolicy,
) -> Result<(), ProviderError> {
    let mut attempt = 0usize;
    loop {
        if cancel.is_cancelled() {
            return Err(ProviderError::Cancelled);
        }
        match run_attempt(
            provider,
            request.clone(),
            &sink,
            &cancel,
            policy.first_token,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) if retryable_status(&error) => {
                let Some(delay) = policy.retries.get(attempt).copied() else {
                    return Err(error);
                };
                attempt += 1;
                tokio::select! {
                    _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                    _ = tokio::time::sleep(delay) => {}
                }
            }
            Err(error) => return Err(explain_edit_error(error)),
        }
    }
}

async fn run_attempt(
    provider: &impl Provider,
    request: ChatRequest,
    sink: &mpsc::Sender<StreamEvent>,
    cancel: &CancellationToken,
    first_token: Duration,
) -> Result<(), ProviderError> {
    let attempt_cancel = cancel.child_token();
    let task_cancel = attempt_cancel.clone();
    let (tx, mut rx) = mpsc::channel(32);
    let producer = provider.stream(request, tx, task_cancel);
    tokio::pin!(producer);
    let mut saw_event = false;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                attempt_cancel.cancel();
                let _ = producer.await;
                return Err(ProviderError::Cancelled);
            }
            event = rx.recv() => {
                match event {
                    Some(event) => {
                        saw_event = true;
                        let done = matches!(event, StreamEvent::Done(_));
                        if sink.send(event).await.is_err() {
                            attempt_cancel.cancel();
                            let _ = producer.await;
                            return Err(ProviderError::Cancelled);
                        }
                        if done {
                            let _ = producer.await;
                            return Ok(());
                        }
                    }
                    None => return producer.await,
                }
            }
            result = &mut producer => {
                while let Ok(event) = rx.try_recv() {
                    let done = matches!(event, StreamEvent::Done(_));
                    if sink.send(event).await.is_err() {
                        return Err(ProviderError::Cancelled);
                    }
                    if done {
                        return result;
                    }
                }
                return result;
            }
            _ = tokio::time::sleep(first_token), if !saw_event => {
                attempt_cancel.cancel();
                let _ = producer.await;
                return Err(ProviderError::FirstToken);
            }
        }
    }
}

fn emit_token(app: &AppHandle, stream_id: &str, delta: &str, kind: &str) {
    let _ = app.emit(
        "ai-token",
        AiToken {
            stream_id: stream_id.to_string(),
            delta: delta.to_string(),
            kind: kind.to_string(),
        },
    );
}

async fn drive(
    app: AppHandle,
    hub: AiHub,
    stream_id: String,
    provider: OpenAiCompatible,
    request: ChatRequest,
    cancel: CancellationToken,
) {
    let (tx, mut rx) = mpsc::channel(32);
    let producer = run_edit_stream(&provider, request, tx, cancel, edit_policy());
    let consumer = async {
        let mut finished = false;
        while let Some(event) = rx.recv().await {
            match event {
                StreamEvent::Delta(delta) => {
                    emit_token(&app, &stream_id, &delta, "content");
                }
                StreamEvent::Reasoning(delta) => {
                    emit_token(&app, &stream_id, &delta, "reasoning");
                }
                StreamEvent::Done(usage) => {
                    finished = true;
                    let _ = app.emit(
                        "ai-done",
                        AiDone {
                            stream_id: stream_id.clone(),
                            usage,
                        },
                    );
                }
            }
        }
        finished
    };
    let (result, finished) = tokio::join!(producer, consumer);
    if let Err(error) = result {
        if !finished {
            let _ = app.emit(
                "ai-error",
                AiError {
                    stream_id: stream_id.clone(),
                    code: error.code().to_string(),
                    message: error.message(),
                },
            );
        }
    }
    hub.finish(&stream_id);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_start(
    app: AppHandle,
    hub: State<'_, AiHub>,
    secrets: State<'_, AiSecrets>,
    provider_id: String,
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    profile_id: Option<String>,
) -> Result<String, String> {
    if provider_id != PROVIDER_ID {
        return Err(format!("不支持的模型服务：{provider_id}"));
    }
    validate_request(&model, &messages, temperature, max_tokens)
        .map_err(|error| error.message())?;
    let api_key = resolve_key(api_key, secrets.get(profile_id.as_deref()))?;
    let provider = OpenAiCompatible::new(&base_url, api_key).map_err(|error| error.message())?;
    if provider.id() != PROVIDER_ID {
        return Err(format!("不支持的模型服务：{}", provider.id()));
    }
    let request = ChatRequest {
        model: model.trim().to_string(),
        messages,
        max_tokens,
        temperature,
    };
    let stream_id = hub.alloc_id();
    let cancel = CancellationToken::new();
    hub.track(&stream_id, cancel.clone());
    let hub = (*hub).clone();
    let id = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        drive(app, hub, id, provider, request, cancel).await;
    });
    Ok(stream_id)
}

#[tauri::command]
pub fn ai_cancel(hub: State<'_, AiHub>, stream_id: String) {
    hub.cancel(&stream_id);
}

#[tauri::command]
pub fn ai_set_key(
    secrets: State<'_, AiSecrets>,
    api_key: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    secrets.set(profile_id.as_deref(), &api_key)
}

#[tauri::command]
pub fn ai_clear_key(
    secrets: State<'_, AiSecrets>,
    profile_id: Option<String>,
) -> Result<(), String> {
    secrets.delete(profile_id.as_deref())
}

#[tauri::command]
pub fn ai_has_key(
    secrets: State<'_, AiSecrets>,
    profile_id: Option<String>,
) -> Result<bool, String> {
    Ok(secrets
        .get(profile_id.as_deref())?
        .is_some_and(|secret| !secret.trim().is_empty()))
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// One short completion used by the settings panel. The key is the typed value
/// or, when that is blank, the keychain entry. The reply text is not stored.
pub async fn probe_model(
    provider: &OpenAiCompatible,
    model: &str,
    timeout: Duration,
) -> Result<String, ProviderError> {
    let cancel = CancellationToken::new();
    let cancel_stream = cancel.clone();
    let request = ChatRequest {
        model: model.trim().to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: "ping".to_string(),
        }],
        max_tokens: None,
        temperature: None,
    };
    let work = async {
        let (tx, mut rx) = mpsc::channel(8);
        let producer = provider.stream(request, tx, cancel_stream);
        let consumer = async {
            let mut text = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    StreamEvent::Delta(delta) | StreamEvent::Reasoning(delta) => {
                        text.push_str(&delta)
                    }
                    StreamEvent::Done(_) => break,
                }
            }
            text
        };
        let (result, text) = tokio::join!(producer, consumer);
        result.map(|()| text)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result,
        Err(_) => {
            cancel.cancel();
            Err(ProviderError::Timeout)
        }
    }
}

#[tauri::command]
pub async fn ai_probe(
    secrets: State<'_, AiSecrets>,
    base_url: String,
    model: String,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    validate_request(
        &model,
        &[ChatMessage {
            role: "user".into(),
            content: "ping".into(),
        }],
        None,
        None,
    )
    .map_err(|error| error.message())?;
    let api_key = resolve_key(api_key, secrets.get(profile_id.as_deref()))?;
    let provider = OpenAiCompatible::new(&base_url, api_key).map_err(|error| error.message())?;
    probe_model(&provider, &model, PROBE_TIMEOUT)
        .await
        .map_err(|error| error.message())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn sample_request() -> ChatRequest {
        ChatRequest {
            model: "demo".to_string(),
            messages: vec![message("user", "改短一点")],
            max_tokens: Some(32),
            temperature: Some(0.2),
        }
    }

    #[test]
    fn joins_the_chat_completions_path() {
        assert_eq!(
            chat_completions_url("http://127.0.0.1:9/v1").unwrap(),
            "http://127.0.0.1:9/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://127.0.0.1:9/v1/").unwrap(),
            "http://127.0.0.1:9/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://127.0.0.1:9/v1/chat/completions").unwrap(),
            "http://127.0.0.1:9/v1/chat/completions"
        );
    }

    #[test]
    fn rejects_a_non_http_base_url() {
        let error = chat_completions_url("file:///tmp/model").unwrap_err();
        assert_eq!(error.message(), "服务地址只支持 http 或 https。");
        assert!(chat_completions_url("not a url").is_err());
    }

    #[test]
    fn rejects_an_empty_prompt_and_a_bad_temperature() {
        let error = validate_request("", &[message("user", "hi")], None, None).unwrap_err();
        assert_eq!(error.message(), "模型名称不能为空。");
        let error = validate_request("m", &[], None, None).unwrap_err();
        assert_eq!(error.message(), "消息不能为空。");
        let error = validate_request("m", &[message("tool", "hi")], None, None).unwrap_err();
        assert!(error.message().contains("tool"));
        let error = validate_request("m", &[message("user", "hi")], Some(3.0), None).unwrap_err();
        assert_eq!(error.message(), "温度必须在 0 到 2 之间。");
        let error = validate_request("m", &[message("user", "hi")], None, Some(0)).unwrap_err();
        assert_eq!(error.message(), "生成长度必须大于 0。");
    }

    #[test]
    fn cancel_is_idempotent() {
        let hub = AiHub::default();
        let token = CancellationToken::new();
        hub.track("ai-1", token.clone());
        assert!(hub.cancel("ai-1"));
        assert!(token.is_cancelled());
        assert!(!hub.cancel("ai-1"));
    }

    struct MockHttp {
        url: String,
        disconnected: Arc<AtomicBool>,
    }

    fn read_request(socket: &mut std::net::TcpStream) -> Vec<u8> {
        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            match socket.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(end) = find_subslice(&buf, b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&buf[..end]);
                        let length = content_length(&headers).unwrap_or(0);
                        if buf.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
            if buf.len() > 65_536 {
                break;
            }
        }
        buf
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn content_length(headers: &str) -> Option<usize> {
        headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
    }

    fn spawn_chunked(first_event: &str) -> MockHttp {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let disconnected = Arc::new(AtomicBool::new(false));
        let closed = disconnected.clone();
        let first_event = first_event.to_string();
        thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let _ = read_request(&mut socket);
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(header.as_bytes());
            let chunk = format!("{:X}\r\n{first_event}\r\n", first_event.len());
            let _ = socket.write_all(chunk.as_bytes());
            let _ = socket.flush();
            let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
            let mut tmp = [0_u8; 8];
            let went_away = match socket.read(&mut tmp) {
                Ok(0) => true,
                Err(error) => {
                    error.kind() != std::io::ErrorKind::TimedOut
                        && error.kind() != std::io::ErrorKind::WouldBlock
                }
                Ok(_) => true,
            };
            closed.store(went_away, Ordering::SeqCst);
        });
        MockHttp {
            url: format!("http://{address}/v1"),
            disconnected,
        }
    }

    async fn collect(
        provider: &OpenAiCompatible,
        cancel: CancellationToken,
    ) -> Result<Vec<StreamEvent>, ProviderError> {
        let (tx, mut rx) = mpsc::channel(8);
        let request = sample_request();
        let producer = provider.stream(request, tx, cancel);
        let consumer = async {
            let mut events = Vec::new();
            while let Some(event) = rx.recv().await {
                let stop = matches!(event, StreamEvent::Done(_));
                events.push(event);
                if stop {
                    break;
                }
            }
            events
        };
        let (result, events) = tokio::join!(producer, consumer);
        result.map(|()| events)
    }

    #[test]
    fn thinking_chunks_and_text_parts_are_visible() {
        let thinking = interpret_chunk(
            r#"{"choices":[{"delta":{"content":null,"reasoning_content":"先想"}}]}"#,
        )
        .unwrap();
        assert_eq!(thinking.reasoning, "先想");
        assert_eq!(thinking.content, "");
        let parts = interpret_chunk(
            r#"{"choices":[{"delta":{"content":[{"type":"text","text":"结果"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(parts.reasoning, "");
        assert_eq!(parts.content, "结果");
        let both =
            interpret_chunk(r#"{"choices":[{"delta":{"reasoning_content":"想","content":"答"}}]}"#)
                .unwrap();
        assert_eq!(both.reasoning, "想");
        assert_eq!(both.content, "答");
    }

    #[tokio::test]
    async fn streams_a_complete_reply_from_an_openai_compatible_server() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let slot = captured.clone();
        let payload = body.to_string();
        thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let received = read_request(&mut socket);
            *slot.lock().unwrap() = received;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = socket.write_all(header.as_bytes());
            let _ = socket.write_all(payload.as_bytes());
            let _ = socket.flush();
        });

        let provider =
            OpenAiCompatible::new(&format!("http://{address}/v1"), Some(" test-key ".into()))
                .unwrap();
        assert_eq!(provider.id(), PROVIDER_ID);
        let events = collect(&provider, CancellationToken::new()).await.unwrap();
        let mut text = String::new();
        let mut usage = None;
        for event in events {
            match event {
                StreamEvent::Delta(delta) => text.push_str(&delta),
                StreamEvent::Reasoning(_) => {}
                StreamEvent::Done(tokens) => usage = tokens,
            }
        }
        assert_eq!(text, "你好");
        assert_eq!(usage.unwrap().completion_tokens, 2);

        let captured = captured.lock().unwrap();
        let raw = String::from_utf8_lossy(&captured);
        let lower = raw.to_ascii_lowercase();
        assert!(lower.contains("post /v1/chat/completions"));
        assert!(lower.contains("authorization: bearer test-key"));
        assert!(raw.contains("\"stream\":true"));
        assert!(raw.contains("改短一点"));
    }

    #[tokio::test]
    async fn http_401_becomes_an_error_and_no_delta() {
        let body = "{\"error\":{\"message\":\"bad key\"}}";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let payload = body.to_string();
        thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let _ = read_request(&mut socket);
            let header = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = socket.write_all(header.as_bytes());
            let _ = socket.write_all(payload.as_bytes());
        });
        let provider = OpenAiCompatible::new(&format!("http://{address}/v1"), None).unwrap();
        let error = collect(&provider, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "http");
        assert_eq!(error.message(), "服务返回 401：bad key");
    }

    #[tokio::test]
    async fn cancel_closes_the_socket_before_the_server_finishes() {
        let server = spawn_chunked("data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n");
        let provider = OpenAiCompatible::new(&server.url, None).unwrap();
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let cancel_stream = cancel.clone();
        let request = sample_request();
        let task = tokio::spawn(async move { provider.stream(request, tx, cancel_stream).await });
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("first token")
            .expect("delta");
        assert!(matches!(first, StreamEvent::Delta(text) if text == "A"));
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancel hung")
            .unwrap();
        assert_eq!(result.unwrap_err().code(), "cancelled");
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !server.disconnected.load(Ordering::SeqCst) {
            if std::time::Instant::now() > deadline {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            server.disconnected.load(Ordering::SeqCst),
            "cancelling did not close the connection"
        );
    }

    #[test]
    fn drops_only_parameters_the_model_names() {
        let detail =
            "auto does not support parameter(s): temperature; please remove them from your request";
        assert_eq!(
            rejected_parameter_names(detail),
            vec!["temperature".to_string()]
        );
        let next = without_rejected_parameters(&sample_request(), detail).unwrap();
        assert!(next.temperature.is_none());
        assert_eq!(next.max_tokens, Some(32));
        let both = "does not support parameter(s): temperature, max_tokens; please remove them";
        let next = without_rejected_parameters(&sample_request(), both).unwrap();
        assert!(next.temperature.is_none());
        assert!(next.max_tokens.is_none());
        assert!(without_rejected_parameters(&sample_request(), "bad key").is_none());
        let cloud = "Unsupported parameter: 'max_tokens' is not supported with this model.";
        let next = without_rejected_parameters(&sample_request(), cloud).unwrap();
        assert_eq!(next.max_tokens, None);
        assert_eq!(next.temperature, Some(0.2));
    }

    #[tokio::test]
    async fn retries_once_without_parameters_the_model_refuses() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let slot = captured.clone();
        thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut socket, _)) = listener.accept() else {
                    return;
                };
                let received = read_request(&mut socket);
                let raw = String::from_utf8_lossy(&received).to_string();
                if raw.contains("\"temperature\"") {
                    let body = "{\"error\":{\"message\":\"auto does not support parameter(s): temperature; please remove them from your request\"}}";
                    let header = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(header.as_bytes());
                    let _ = socket.write_all(body.as_bytes());
                } else {
                    *slot.lock().unwrap() = raw;
                    let body = "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\ndata: [DONE]\n\n";
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(header.as_bytes());
                    let _ = socket.write_all(body.as_bytes());
                }
            }
        });
        let provider = OpenAiCompatible::new(&format!("http://{address}/v1"), None).unwrap();
        let events = collect(&provider, CancellationToken::new()).await.unwrap();
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::Delta(delta) => Some(delta.as_str()),
                StreamEvent::Reasoning(_) | StreamEvent::Done(_) => None,
            })
            .collect();
        assert_eq!(text, "pong");
        let second = captured.lock().unwrap();
        assert!(second.contains("改短一点"));
        assert!(!second.contains("temperature"));
    }

    #[tokio::test]
    async fn probe_returns_the_model_text() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\ndata: [DONE]\n\n";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let payload = body.to_string();
        thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let _ = read_request(&mut socket);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = socket.write_all(header.as_bytes());
            let _ = socket.write_all(payload.as_bytes());
        });
        let provider = OpenAiCompatible::new(&format!("http://{address}/v1"), None).unwrap();
        let text = probe_model(&provider, "demo", Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(text, "pong");
    }

    #[tokio::test]
    async fn probe_times_out_when_the_server_never_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let _ = read_request(&mut socket);
            thread::sleep(Duration::from_secs(2));
        });
        let provider = OpenAiCompatible::new(&format!("http://{address}/v1"), None).unwrap();
        let error = probe_model(&provider, "demo", Duration::from_millis(300))
            .await
            .unwrap_err();
        assert_eq!(error.code(), "timeout");
        assert_eq!(error.message(), "等待模型响应超时。");
    }

    const QUICK_RETRY: [Duration; 2] = [Duration::from_millis(15), Duration::from_millis(15)];
    const SLOW_RETRY: [Duration; 1] = [Duration::from_secs(5)];

    fn http_message(status: u16, reason: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn sse_pong() -> String {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\ndata: [DONE]\n\n";
        http_message(200, "OK", "text/event-stream", body)
    }

    fn spawn_sequence(responses: Vec<String>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        thread::spawn(move || {
            for response in responses {
                let Ok((mut socket, _)) = listener.accept() else {
                    return;
                };
                let _ = read_request(&mut socket);
                count.fetch_add(1, Ordering::SeqCst);
                let _ = socket.write_all(response.as_bytes());
                let _ = socket.flush();
            }
        });
        (format!("http://{address}/v1"), hits)
    }

    struct WatchedEdit {
        result: Result<(), ProviderError>,
        text: String,
        done: bool,
    }

    async fn watch_edit(
        provider: &impl Provider,
        policy: EditPolicy,
        cancel: CancellationToken,
    ) -> WatchedEdit {
        let (tx, mut rx) = mpsc::channel(8);
        let request = sample_request();
        let producer = run_edit_stream(provider, request, tx, cancel, policy);
        let consumer = async {
            let mut text = String::new();
            let mut done = false;
            while let Some(event) = rx.recv().await {
                match event {
                    StreamEvent::Delta(delta) | StreamEvent::Reasoning(delta) => {
                        text.push_str(&delta)
                    }
                    StreamEvent::Done(_) => {
                        done = true;
                        break;
                    }
                }
            }
            (text, done)
        };
        let (result, (text, done)) = tokio::join!(producer, consumer);
        WatchedEdit { result, text, done }
    }

    async fn collect_edit(
        provider: &impl Provider,
        policy: EditPolicy,
        cancel: CancellationToken,
    ) -> Result<String, ProviderError> {
        let watched = watch_edit(provider, policy, cancel).await;
        watched.result.map(|()| watched.text)
    }

    #[tokio::test]
    async fn edit_path_returns_a_fast_reply_without_retrying() {
        let (url, hits) = spawn_sequence(vec![
            sse_pong(),
            http_message(500, "Err", "text/plain", "no"),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let policy = EditPolicy {
            first_token: Duration::from_secs(2),
            retries: &QUICK_RETRY,
        };
        let text = collect_edit(&provider, policy, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(text, "pong");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edit_path_retries_429_then_returns_the_reply() {
        let (url, hits) = spawn_sequence(vec![
            http_message(
                429,
                "Too Many",
                "application/json",
                "{\"error\":{\"message\":\"slow down\"}}",
            ),
            sse_pong(),
            http_message(500, "Err", "text/plain", "extra"),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let policy = EditPolicy {
            first_token: Duration::from_secs(2),
            retries: &QUICK_RETRY,
        };
        let text = collect_edit(&provider, policy, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(text, "pong");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn edit_path_stops_after_two_retries() {
        let fail = http_message(
            503,
            "Unavailable",
            "application/json",
            "{\"error\":{\"message\":\"down\"}}",
        );
        let (url, hits) = spawn_sequence(vec![
            fail.clone(),
            fail.clone(),
            fail,
            http_message(200, "OK", "text/plain", "late"),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let policy = EditPolicy {
            first_token: Duration::from_secs(2),
            retries: &QUICK_RETRY,
        };
        let error = collect_edit(&provider, policy, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "http");
        assert!(error.message().contains("503"));
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn edit_path_does_not_retry_an_invalid_key() {
        let (url, hits) = spawn_sequence(vec![
            http_message(
                401,
                "Unauthorized",
                "application/json",
                "{\"error\":{\"message\":\"bad key\"}}",
            ),
            sse_pong(),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let policy = EditPolicy {
            first_token: Duration::from_secs(2),
            retries: &QUICK_RETRY,
        };
        let error = collect_edit(&provider, policy, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.message(), "密钥无效或没有权限。");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edit_path_cancels_during_backoff() {
        let (url, hits) = spawn_sequence(vec![
            http_message(
                429,
                "Too Many",
                "application/json",
                "{\"error\":{\"message\":\"slow down\"}}",
            ),
            sse_pong(),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let policy = EditPolicy {
            first_token: Duration::from_secs(2),
            retries: &SLOW_RETRY,
        };
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let seen = hits.clone();
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while seen.load(Ordering::SeqCst) == 0 {
                if std::time::Instant::now() > deadline {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            stop.cancel();
        });
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            collect_edit(&provider, policy, cancel),
        )
        .await
        .expect("backoff cancel hung")
        .unwrap_err();
        assert_eq!(error.code(), "cancelled");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edit_path_cancels_when_the_first_token_never_arrives() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let disconnected = Arc::new(AtomicBool::new(false));
        let closed = disconnected.clone();
        thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let _ = read_request(&mut socket);
            let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
            let mut tmp = [0_u8; 8];
            let went_away = match socket.read(&mut tmp) {
                Ok(0) => true,
                Err(error) => {
                    error.kind() != std::io::ErrorKind::TimedOut
                        && error.kind() != std::io::ErrorKind::WouldBlock
                }
                Ok(_) => true,
            };
            closed.store(went_away, Ordering::SeqCst);
        });
        let provider = OpenAiCompatible::new(&format!("http://{address}/v1"), None).unwrap();
        let policy = EditPolicy {
            first_token: Duration::from_millis(200),
            retries: &[],
        };
        let error = collect_edit(&provider, policy, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "timeout");
        assert_eq!(
            error.message(),
            "15 秒内没有收到模型的第一个字，已取消。可以改用本地模型。"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !disconnected.load(Ordering::SeqCst) {
            if std::time::Instant::now() > deadline {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            disconnected.load(Ordering::SeqCst),
            "first-token timeout did not close the connection"
        );
    }

    /// Fixed replay. Edit-path tests use this instead of a socket so CI never
    /// leaves the machine, and never needs an API key.
    enum MockStep {
        Events(Vec<StreamEvent>),
        Fail(ProviderError),
        EventsThenFail(Vec<StreamEvent>, ProviderError),
        Hang,
        EventsThenHang(Vec<StreamEvent>),
        Gap {
            head: Vec<StreamEvent>,
            pause: Duration,
            tail: Vec<StreamEvent>,
        },
    }

    struct MockProvider {
        steps: Mutex<VecDeque<MockStep>>,
        calls: AtomicUsize,
    }

    impl MockProvider {
        fn new(steps: Vec<MockStep>) -> Self {
            Self {
                steps: Mutex::new(VecDeque::from(steps)),
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Provider for MockProvider {
        fn id(&self) -> &str {
            "mock"
        }

        async fn stream(
            &self,
            _request: ChatRequest,
            sink: mpsc::Sender<StreamEvent>,
            cancel: CancellationToken,
        ) -> Result<(), ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let step = lock(&self.steps)
                .pop_front()
                .expect("mock script has no step left");
            match step {
                MockStep::Fail(error) => Err(error),
                MockStep::Hang => {
                    cancel.cancelled().await;
                    Err(ProviderError::Cancelled)
                }
                MockStep::Events(events) => replay(&sink, &cancel, events).await,
                MockStep::EventsThenFail(events, error) => {
                    replay(&sink, &cancel, events).await?;
                    Err(error)
                }
                MockStep::EventsThenHang(events) => {
                    replay(&sink, &cancel, events).await?;
                    cancel.cancelled().await;
                    Err(ProviderError::Cancelled)
                }
                MockStep::Gap { head, pause, tail } => {
                    replay(&sink, &cancel, head).await?;
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                        _ = tokio::time::sleep(pause) => {}
                    }
                    replay(&sink, &cancel, tail).await
                }
            }
        }
    }

    async fn replay(
        sink: &mpsc::Sender<StreamEvent>,
        cancel: &CancellationToken,
        events: Vec<StreamEvent>,
    ) -> Result<(), ProviderError> {
        for event in events {
            if cancel.is_cancelled() {
                return Err(ProviderError::Cancelled);
            }
            sink.send(event)
                .await
                .map_err(|_| ProviderError::Cancelled)?;
        }
        Ok(())
    }

    fn fast_edit() -> EditPolicy {
        EditPolicy {
            first_token: Duration::from_secs(2),
            retries: &QUICK_RETRY,
        }
    }

    fn status(code: u16, detail: &str) -> MockStep {
        MockStep::Fail(ProviderError::Http {
            status: code,
            detail: detail.to_string(),
        })
    }

    fn pong() -> MockStep {
        MockStep::Events(vec![
            StreamEvent::Delta("pong".to_string()),
            StreamEvent::Done(None),
        ])
    }

    fn delta(text: &str) -> StreamEvent {
        StreamEvent::Delta(text.to_string())
    }

    #[tokio::test]
    async fn mock_times_out_before_the_first_token() {
        let provider = MockProvider::new(vec![MockStep::Hang, pong()]);
        let policy = EditPolicy {
            first_token: Duration::from_millis(40),
            retries: &[],
        };
        let watched = tokio::time::timeout(
            Duration::from_secs(2),
            watch_edit(&provider, policy, CancellationToken::new()),
        )
        .await
        .expect("first-token timeout hung");
        let error = watched.result.unwrap_err();
        assert_eq!(error.code(), "timeout");
        assert_eq!(
            error.message(),
            "15 秒内没有收到模型的第一个字，已取消。可以改用本地模型。"
        );
        assert_eq!(watched.text, "");
        assert!(!watched.done);
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_retries_a_rate_limit_then_returns_the_reply() {
        let provider = MockProvider::new(vec![status(429, "slow down"), pong()]);
        let text = collect_edit(&provider, fast_edit(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(text, "pong");
        assert_eq!(provider.calls(), 2);
    }

    #[tokio::test]
    async fn mock_stops_when_the_rate_limit_retries_are_spent() {
        let provider = MockProvider::new(vec![
            status(429, "slow down"),
            status(429, "slow down"),
            status(429, "slow down"),
            pong(),
        ]);
        let watched = watch_edit(&provider, fast_edit(), CancellationToken::new()).await;
        let error = watched.result.unwrap_err();
        assert_eq!(error.code(), "http");
        assert_eq!(error.message(), "服务返回 429：slow down");
        assert_eq!(watched.text, "");
        assert!(!watched.done);
        assert_eq!(provider.calls(), 3);
    }

    #[tokio::test]
    async fn mock_retries_a_server_error_then_returns_the_reply() {
        let provider = MockProvider::new(vec![status(503, "down"), pong()]);
        let text = collect_edit(&provider, fast_edit(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(text, "pong");
        assert_eq!(provider.calls(), 2);
    }

    #[tokio::test]
    async fn mock_does_not_retry_a_dropped_connection() {
        let provider = MockProvider::new(vec![
            MockStep::Fail(ProviderError::Network("connection refused".to_string())),
            pong(),
        ]);
        let watched = watch_edit(&provider, fast_edit(), CancellationToken::new()).await;
        let error = watched.result.unwrap_err();
        assert_eq!(error.code(), "network");
        assert_eq!(error.message(), "无法连接模型服务：connection refused");
        assert_eq!(watched.text, "");
        assert!(!watched.done);
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_keeps_the_partial_reply_when_the_stream_drops() {
        let provider = MockProvider::new(vec![
            MockStep::EventsThenFail(
                vec![delta("半截")],
                ProviderError::Network("connection reset".to_string()),
            ),
            pong(),
        ]);
        let watched = watch_edit(&provider, fast_edit(), CancellationToken::new()).await;
        let error = watched.result.unwrap_err();
        assert_eq!(error.code(), "network");
        assert_eq!(error.message(), "无法连接模型服务：connection reset");
        assert_eq!(watched.text, "半截");
        assert!(!watched.done);
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_cancel_before_any_token_writes_nothing() {
        let provider = MockProvider::new(vec![MockStep::Hang, pong()]);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            stop.cancel();
        });
        let watched = tokio::time::timeout(
            Duration::from_secs(2),
            watch_edit(&provider, fast_edit(), cancel),
        )
        .await
        .expect("cancel hung");
        let error = watched.result.unwrap_err();
        assert_eq!(error.code(), "cancelled");
        assert_eq!(error.message(), "已取消。");
        assert_eq!(watched.text, "");
        assert!(!watched.done);
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_cancel_after_a_delta_does_not_finish() {
        let provider = Arc::new(MockProvider::new(vec![
            MockStep::EventsThenHang(vec![delta("半")]),
            pong(),
        ]));
        let running = provider.clone();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let (tx, mut rx) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            run_edit_stream(&*running, sample_request(), tx, cancel, fast_edit()).await
        });
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("delta hung")
            .expect("delta missing");
        assert!(matches!(first, StreamEvent::Delta(text) if text == "半"));
        stop.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancel hung")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code(), "cancelled");
        assert!(rx.recv().await.is_none());
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_two_requests_do_not_mix_replies() {
        let provider = MockProvider::new(vec![
            MockStep::Events(vec![delta("one"), StreamEvent::Done(None)]),
            MockStep::Events(vec![delta("two"), StreamEvent::Done(None)]),
        ]);
        let policy = fast_edit();
        let (left, right) = tokio::join!(
            collect_edit(&provider, policy, CancellationToken::new()),
            collect_edit(&provider, policy, CancellationToken::new()),
        );
        let mut texts = vec![left.unwrap(), right.unwrap()];
        texts.sort();
        assert_eq!(texts, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(provider.calls(), 2);
    }

    #[tokio::test]
    async fn mock_delivers_a_long_reply_without_truncating() {
        let long = "字".repeat(20_000);
        let provider = MockProvider::new(vec![MockStep::Events(vec![
            delta(&long),
            StreamEvent::Done(None),
        ])]);
        let text = collect_edit(&provider, fast_edit(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(text, long);
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_does_not_cut_a_reply_that_pauses_after_the_first_token() {
        let provider = MockProvider::new(vec![MockStep::Gap {
            head: vec![delta("已")],
            pause: Duration::from_millis(180),
            tail: vec![StreamEvent::Done(None)],
        }]);
        let policy = EditPolicy {
            first_token: Duration::from_millis(50),
            retries: &[],
        };
        let started = std::time::Instant::now();
        let text = tokio::time::timeout(
            Duration::from_secs(2),
            collect_edit(&provider, policy, CancellationToken::new()),
        )
        .await
        .expect("pause hung")
        .unwrap();
        assert_eq!(text, "已");
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn mock_does_not_retry_a_forbidden_key() {
        let provider = MockProvider::new(vec![status(403, "nope"), pong()]);
        let error = collect_edit(&provider, fast_edit(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.message(), "密钥无效或没有权限。");
        assert_eq!(error.code(), "http");
        assert_eq!(provider.calls(), 1);
    }

    fn chunk_error(data: &str) -> ProviderError {
        match interpret_chunk(data) {
            Ok(_) => panic!("expected a chunk error"),
            Err(error) => error,
        }
    }

    #[test]
    fn a_truncated_chunk_is_a_protocol_error() {
        let error = chunk_error("{\"choices\":[{\"delta\":{\"content\":\"半");
        assert_eq!(error.code(), "protocol");
        assert!(error.message().starts_with("模型响应无法解析："));
        let upstream = chunk_error(r#"{"error":{"message":"overloaded"}}"#);
        assert_eq!(upstream.code(), "upstream");
        assert_eq!(upstream.message(), "模型服务错误：overloaded");
    }

    #[tokio::test]
    async fn edit_path_rejects_a_truncated_json_event_without_retrying() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"半\"}\n\n";
        let (url, hits) = spawn_sequence(vec![
            http_message(200, "OK", "text/event-stream", body),
            sse_pong(),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let watched = watch_edit(&provider, fast_edit(), CancellationToken::new()).await;
        let error = watched.result.unwrap_err();
        assert_eq!(error.code(), "protocol");
        assert!(error.message().starts_with("模型响应无法解析："));
        assert_eq!(watched.text, "");
        assert!(!watched.done);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edit_path_finishes_when_the_socket_closes_after_one_event() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"半截\"}}]}\n\n";
        let (url, hits) = spawn_sequence(vec![http_message(200, "OK", "text/event-stream", body)]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let watched = watch_edit(&provider, fast_edit(), CancellationToken::new()).await;
        watched.result.unwrap();
        assert_eq!(watched.text, "半截");
        assert!(watched.done);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edit_path_does_not_retry_an_upstream_error_event() {
        let body = "data: {\"error\":{\"message\":\"overloaded\"}}\n\n";
        let (url, hits) = spawn_sequence(vec![
            http_message(200, "OK", "text/event-stream", body),
            sse_pong(),
        ]);
        let provider = OpenAiCompatible::new(&url, None).unwrap();
        let error = collect_edit(&provider, fast_edit(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "upstream");
        assert_eq!(error.message(), "模型服务错误：overloaded");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn edit_path_does_not_retry_when_the_socket_drops() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        thread::spawn(move || {
            for _ in 0..4 {
                let Ok((socket, _)) = listener.accept() else {
                    return;
                };
                count.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        let provider = OpenAiCompatible::new(&format!("http://{address}/v1"), None).unwrap();
        let error = collect_edit(&provider, fast_edit(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "network");
        assert!(error.message().starts_with("无法连接模型服务："));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
