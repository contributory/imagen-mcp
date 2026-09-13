import { supabaseMcpHandler } from "../../../mcp-image-server.ts";

Deno.serve((req) => supabaseMcpHandler.fetch(req));
