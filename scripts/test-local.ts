/**
 * Local smoke test for the MCP image server.
 *
 * Usage:
 *   deno run --allow-net --allow-env scripts/test-local.ts
 *
 * It exercises the MCP JSON-RPC flow (initialize → tools/list → tools/call)
 * directly against the handler, so no running server or real API key is needed.
 * Without an API key in the request, tools/call returns a helpful error — that
 * is expected.
 */

import { mcpHandler } from "../mcp-image-server.ts";

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

async function post(body: string): Promise<{ status: number; text: string }> {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body,
  });
  const res = await mcpHandler.fetch(req);
  return { status: res.status, text: await res.text() };
}

function pretty(raw: string): string {
  try {
    const lines = raw.split("\n");
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!data) return raw;
    return JSON.stringify(JSON.parse(data), null, 2);
  } catch {
    return raw;
  }
}

async function main() {
  console.log("=== 1. initialize ===");
  const init = await post(rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "local-test", version: "1.0.0" },
  }));
  console.log(`status: ${init.status}`);
  console.log(pretty(init.text));

  console.log("\n=== 2. tools/list ===");
  const tools = await post(rpc(2, "tools/list"));
  console.log(`status: ${tools.status}`);
  console.log(pretty(tools.text));
  const toolNames = [...tools.text.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
  for (const name of ["generate_image", "list_models", "list_images"]) {
    if (!toolNames.includes(name)) throw new Error(`FAIL: tools/list missing ${name}`);
  }
  console.log("tools:", toolNames.join(", "));

  console.log("\n=== 3. tools/call generate_image (no API key → expect error) ===");
  const call = await post(rpc(3, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a cute corgi astronaut", size: "1024x1024" },
  }));
  console.log(`status: ${call.status}`);
  console.log(pretty(call.text));

  console.log("\nDone. ✅");
}

await main();
