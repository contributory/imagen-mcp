import { supabaseMcpHandler } from "../../../main.ts";

Deno.serve((req) => supabaseMcpHandler.fetch(req));
