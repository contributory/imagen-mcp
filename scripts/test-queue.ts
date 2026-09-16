/** E2E smoke for the Supabase async queue MCP variant. */
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:8791");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");

const { supabaseMcpHandler } = await import("../main.ts");

interface JobState {
  id: string;
  created_at: string;
  updated_at: string;
  status: "queued" | "processing" | "completed" | "failed";
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
}

const jobState: { current: JobState | null } = { current: null };
let queuedPayload: Record<string, unknown> | null = null;
let workerKicks = 0;

const mock = Deno.serve({ port: 8791, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/rest/v1/rpc/imagen_enqueue_image_job") {
    const body = await req.json() as {
      p_job_id: string;
      p_request: Record<string, unknown>;
      p_payload: Record<string, unknown>;
    };
    if ("api_key" in body.p_request) return Response.json({ error: "api key leaked into job row" }, { status: 500 });
    jobState.current = {
      id: body.p_job_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "queued",
      request: body.p_request,
      result: null,
      error: null,
      attempts: 0,
    };
    queuedPayload = body.p_payload;
    return Response.json(123);
  }
  if (req.method === "POST" && url.pathname === "/functions/v1/imagen-mcp-worker") {
    workerKicks++;
    return Response.json({ accepted: true }, { status: 202 });
  }
  if (req.method === "GET" && url.pathname === "/rest/v1/image_jobs") {
    const requestedId = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    return Response.json(jobState.current && jobState.current.id === requestedId ? [jobState.current] : []);
  }
  return Response.json({ error: `unhandled ${req.method} ${url.pathname}` }, { status: 404 });
});

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

async function post(body: string): Promise<{ status: number; text: string }> {
  const req = new Request("http://localhost/mcp?defaultModel=qwen-image-2.0", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "X-Api-Key": "upstream-secret",
      "X-Base-Url": "https://images.example.test/v1",
    },
    body,
  });
  const res = await supabaseMcpHandler.fetch(req);
  return { status: res.status, text: await res.text() };
}

function resultOf(raw: string): Record<string, unknown> {
  const data = raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  return JSON.parse(data ?? raw) as Record<string, unknown>;
}

try {
  console.log("=== queue tools/list ===");
  const listed = resultOf((await post(rpc(1, "tools/list"))).text);
  const tools = ((listed.result as { tools?: { name?: string }[] })?.tools ?? []).map((tool) => tool.name);
  for (const name of ["generate_image", "get_image_job", "list_models"]) {
    if (!tools.includes(name)) throw new Error(`missing tool ${name}`);
  }
  console.log("tools:", tools.join(", "));

  console.log("=== enqueue generate_image ===");
  const generated = resultOf((await post(rpc(2, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "queue me", n: 1 },
  }))).text);
  const structured = (generated.result as { structuredContent?: { job_id?: string; status?: string } })?.structuredContent;
  if (!structured?.job_id || structured.status !== "queued") throw new Error(`unexpected enqueue result ${JSON.stringify(structured)}`);
  if (!jobState.current || jobState.current.id !== structured.job_id) throw new Error("job row was not created");
  const payload = queuedPayload as { api_key?: string; base_url?: string; default_model?: string; args?: { prompt?: string } } | null;
  if (payload?.api_key !== "upstream-secret" || payload.base_url !== "https://images.example.test/v1" || payload.default_model !== "qwen-image-2.0") {
    throw new Error(`queue payload missing upstream config: ${JSON.stringify(payload)}`);
  }
  if (jobState.current.request.default_model !== "qwen-image-2.0") throw new Error(`job metadata missing default model: ${JSON.stringify(jobState.current.request)}`);
  if (workerKicks !== 1) throw new Error(`expected initial worker kick, got ${workerKicks}`);
  console.log("queued:", structured.job_id);

  console.log("=== poll queued job ===");
  const queued = resultOf((await post(rpc(3, "tools/call", {
    name: "get_image_job",
    arguments: { job_id: structured.job_id },
  }))).text);
  const queuedStatus = (queued.result as { structuredContent?: { status?: string } })?.structuredContent?.status;
  if (queuedStatus !== "queued") throw new Error(`expected queued, got ${queuedStatus}`);

  if (!jobState.current) throw new Error("job disappeared");
  jobState.current.status = "completed";
  jobState.current.attempts = 1;
  jobState.current.result = {
    model: "qwen-image-2.0",
    images: [{ index: 0, url: "https://storage.example.test/image.png" }],
  };

  console.log("=== poll completed job ===");
  const completed = resultOf((await post(rpc(4, "tools/call", {
    name: "get_image_job",
    arguments: { job_id: structured.job_id },
  }))).text);
  const completedResult = (completed.result as { structuredContent?: { status?: string; result?: unknown } })?.structuredContent;
  if (completedResult?.status !== "completed") throw new Error(`expected completed, got ${JSON.stringify(completedResult)}`);
  if (!JSON.stringify(completedResult.result).includes("https://storage.example.test/image.png")) {
    throw new Error("completed result missing image URL");
  }
  console.log("queue MCP checks passed ✅");
} finally {
  await new Promise((resolve) => setTimeout(resolve, 20));
  mock.shutdown();
}
