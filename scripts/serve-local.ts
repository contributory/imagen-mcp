/**
 * Local HTTP server wrapper for the MCP image server.
 *
 * Val Town calls the default export as a function directly, but `deno serve`
 * expects an object default export — this wrapper bridges the two so you can
 * test locally with any MCP client:
 *
 *   deno run --allow-net --allow-env --allow-import scripts/serve-local.ts
 *   # then point your MCP client at http://127.0.0.1:8789
 *
 * No server env vars needed — pass the API key / base URL per request via
 * headers (X-OpenAI-Api-Key, X-OpenAI-Base-Url) or query params.
 * Env: PORT (default 8789) for the local port only.
 */

import handler from "../mcp-image-server.ts";

const port = Number(Deno.env.get("PORT") ?? 8789);
const hostname = "127.0.0.1";

Deno.serve({ port, hostname, onListen: () => {
  console.log(`imagen-mcp MCP server listening on http://${hostname}:${port}`);
  console.log("Connect an MCP client with the Streamable HTTP transport.");
} }, handler);
