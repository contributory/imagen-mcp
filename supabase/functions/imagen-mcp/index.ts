import handler from "../../../mcp-image-server.ts";

Deno.serve((req) => handler(req));
