#!/usr/bin/env node
/**
 * End-to-end check for the MCP bridge against the installed app.
 *
 * Prerequisites:
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
 *   Start-Process "$env:LOCALAPPDATA\6byte\6byte.exe"
 *
 * The script drives the app through CDP, points the local agent at a temporary
 * workspace, then talks to `6byte-mcp` over stdio. It restores the previous
 * localStorage state and removes the temporary workspace before exiting.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const port = Number(process.env.SIXBYTE_CDP_PORT || 9222);
const mcpPath =
  process.env.SIXBYTE_MCP || path.join(process.env.LOCALAPPDATA || "", "6byte", "6byte-mcp.exe");
const discoveryPath =
  process.env.SIXBYTE_AGENT_FILE ||
  path.join(process.env.APPDATA || "", "dev.aneditor.app", "local-agent.json");

const workspace = path.join(tmpdir(), `6byte-mcp-e2e-${process.pid}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(condition, label, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function pageTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json();
  return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

async function connect() {
  const target = await pageTarget();
  if (!target) throw new Error("no WebView2 page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.text || "evaluate failed");
    }
    return reply.result?.result?.value;
  };
  return { socket, evaluate };
}

function readDiscovery() {
  if (!existsSync(discoveryPath)) return null;
  try {
    return JSON.parse(readFileSync(discoveryPath, "utf8"));
  } catch {
    return null;
  }
}

async function waitForAgent() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const discovery = readDiscovery();
    if (discovery?.origin && discovery?.token) {
      try {
        const response = await fetch(`${discovery.origin}/v1/editor`, {
          headers: { Authorization: `Bearer ${discovery.token}` },
        });
        if (response.ok) return discovery;
      } catch {
        /* the port may not be listening yet */
      }
    }
    await sleep(100);
  }
  throw new Error("local agent did not start");
}

function startMcp() {
  const child = spawn(mcpPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  lines.on("line", (line) => {
    const next = waiting.shift();
    if (!next) return;
    clearTimeout(next.timer);
    try {
      next.resolve(JSON.parse(line));
    } catch (error) {
      next.reject(error);
    }
  });
  let nextId = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiting.findIndex((item) => item.timer === timer);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error(`MCP ${method} timed out`));
      }, 15_000);
      waiting.push({ resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }) + "\n");
    });
  return { child, call };
}

function toolText(response) {
  return response?.result?.content?.[0]?.text ?? "";
}

function toolError(response) {
  return response?.result?.isError === true;
}

async function main() {
  if (!mcpPath || !existsSync(mcpPath)) {
    console.log(`6byte-mcp not found: ${mcpPath}`);
    process.exit(2);
  }
  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
  writeFileSync(path.join(workspace, "note.md"), "# Note\n\nfirst line\nsecond line\n");
  writeFileSync(path.join(workspace, "other.md"), "# Other\n\nalpha\nbeta\n");
  writeFileSync(path.join(workspace, "docs", "a.md"), "# Doc A\n\ncontent\n");
  writeFileSync(path.join(workspace, "node_modules", "c.md"), "ignored\n");
  writeFileSync(path.join(workspace, ".env"), "SECRET=1\n");

  const { socket, evaluate } = await connect();
  await evaluate("document.querySelector('.app') !== null");
  const backup = await evaluate(
    "(async () => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])))()"
  );

  try {
    await evaluate(`
      localStorage.setItem('ainative.session', '[]');
      localStorage.setItem('ainative.workspace', JSON.stringify({ version: 1, rootPath: ${JSON.stringify(
        workspace.replaceAll("\\", "/")
      )} }));
      localStorage.setItem('ainative.treeHidden', '0');
      localStorage.setItem('ainative.localAgent', '1');
      localStorage.setItem('ainative.preview', '0');
      'ok'
    `);
    await evaluate("setTimeout(() => location.reload(), 50); 'reloading'");
    await sleep(5000);
    const discovery = await waitForAgent();
    check(Boolean(discovery), "local agent starts for the temporary workspace");

    const { child, call } = startMcp();
    try {
      const init = await call("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "6byte-e2e", version: "1" },
      });
      check(init.result?.protocolVersion === "2025-06-18", "unsupported protocol falls back");

      const listed = await call("tools/list", {});
      const names = (listed.result?.tools ?? []).map((tool) => tool.name);
      for (const name of ["open_document", "find_files", "read_document", "propose_edit"]) {
        check(names.includes(name), `tools/list includes ${name}`);
      }

      const found = JSON.parse(
        toolText(await call("tools/call", { name: "find_files", arguments: { pattern: "*.md" } }))
      );
      const foundNames = (found.files ?? []).map((file) => file.name);
      check(
        JSON.stringify(foundNames) === JSON.stringify(["a.md", "note.md", "other.md"]),
        "find_files returns workspace documents only",
        JSON.stringify(foundNames)
      );

      const document = JSON.parse(
        toolText(
          await call("tools/call", { name: "read_document", arguments: { path: "note.md" } })
        )
      );
      check(
        document.text?.includes("# Note") && document.lines === 4,
        "read_document reads the file"
      );

      const opened = JSON.parse(
        toolText(
          await call("tools/call", { name: "open_document", arguments: { path: "other.md" } })
        )
      );
      check(opened.name === "other.md", "open_document switches the editor");

      const span = JSON.parse(
        toolText(
          await call("tools/call", {
            name: "read_range",
            arguments: { start: 3, end: 4 },
          })
        )
      );
      check(span.text === "alpha\nbeta", "read_range reads the current document without a path");

      const editor = JSON.parse(
        toolText(await call("tools/call", { name: "get_editor", arguments: {} }))
      );
      check(typeof editor.revision === "number", "get_editor returns a revision");

      const proposed = await call("tools/call", {
        name: "propose_edit",
        arguments: { revision: editor.revision, from: 0, to: 0, text: "INTRO\n" },
      });
      const proposal = JSON.parse(toolText(proposed));
      check(
        proposal.status === "offered" && proposal.saved === false,
        "propose_edit offers an insertion without saving",
        toolText(proposed)
      );
      await sleep(400);
      const painted = await evaluate(
        "({ text: document.querySelector('.cm-ai-proposal__text')?.textContent ?? null, original: document.querySelector('.cm-ai-original') !== null })"
      );
      check(
        painted.text?.includes("INTRO") && painted.original === false,
        "the editor shows an insertion candidate without an original range",
        JSON.stringify(painted)
      );

      const blocked = await call("tools/call", {
        name: "open_document",
        arguments: { path: ".env" },
      });
      check(toolError(blocked), "open_document rejects secret paths");
    } finally {
      child.stdin.end();
    }
  } finally {
    await evaluate(`
      (() => {
        const keep = ${JSON.stringify(Object.keys(backup ?? {}))};
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('ainative.') && !keep.includes(key)) localStorage.removeItem(key);
        }
        const values = ${JSON.stringify(backup ?? {})};
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        return 'restored';
      })()
    `);
    await evaluate("setTimeout(() => location.reload(), 50); 'reloading'");
    socket.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.log(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
}
console.log(
  failures === 0 ? "MCP E2E: all checks passed." : `MCP E2E: ${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
