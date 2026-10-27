import { createServer } from "node:http";

const port = Number(process.env.AI_MOCK_PORT ?? process.argv[2] ?? 11435);

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function event(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function stream(response, payloads) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const payload of payloads) response.write(event(payload));
  response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end('{"error":{"message":"invalid JSON"}}');
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((message) => message?.role === "tool");
  if (Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResult) {
    stream(response, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "mock-read",
                  type: "function",
                  function: {
                    name: "read_range",
                    arguments: '{"path":"e2e-ai.txt","start":1,"count":5}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    return;
  }
  if (hasToolResult) {
    stream(response, [
      { choices: [{ delta: { content: "mock answer: e2e-ai.txt:1" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    return;
  }
  stream(response, [
    { choices: [{ delta: { content: "rewritten text" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`AI mock listening on ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
