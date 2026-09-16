/**
 * Standalone HTTP server for main.ts (the MCP image server).
 *
 *   deno run --allow-net --allow-env --allow-import scripts/serve.ts
 *   # MCP Streamable HTTP at http://127.0.0.1:8000/mcp (path-agnostic handler)
 *
 * No server env vars needed — pass API key / base URL per request via headers
 * (X-Api-Key, X-Base-Url, or multi-provider X-Base-Url-N / X-Api-Key-N +
 * X-Provider) or query params.
 * Env: PORT (default 8000), HOST (default 0.0.0.0).
 */

import handler from "../main.ts";

const port = Number(Deno.env.get("PORT") ?? 8000);
const hostname = Deno.env.get("HOST") ?? "0.0.0.0";

Deno.serve({ port, hostname, onListen: ({ hostname, port }) => {
  console.log(`imagen-mcp MCP server listening on http://${hostname}:${port}`);
  console.log("Connect an MCP client with the Streamable HTTP transport.");
  console.log("Health: GET /health is not implemented; MCP endpoint serves any path.");
} }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ name: "imagen-mcp", status: "ok" });
  }
  return await handler(req);
});
