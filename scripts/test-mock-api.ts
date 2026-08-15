/**
 * End-to-end test against a mock OpenAI-compatible image API.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-import scripts/test-mock-api.ts
 *
 * Starts a tiny local mock API on port 8788, then verifies the server reads the
 * API config from request headers / query params (no env vars needed) and
 * auto-selects the model via GET /models:
 *   - generate_image via X-OpenAI-* headers (model auto-selected from /models)
 *   - generate_image via URL query params
 *   - generate_image via Authorization: Bearer
 *   - list_models via headers
 *   - missing API key -> helpful error
 *   - list_images -> blob-storage message (only on Val Town)
 *   - remembered model reused (no re-query of /models)
 */

const { mcpHandler } = await import("../mcp-image-server.ts");

// ---- mock API server ------------------------------------------------------
const MOCK_URL = "https://cdn.example.com/img-1.png";
const MOCK_MODELS = ["dall-e-3", "gpt-image-1", "flux-1.1-pro"];

let lastGenerationModel: string | undefined;
let modelsCalls = 0;
const mock = Deno.serve({ port: 8788, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/v1/images/generations") {
    const body = await req.json() as { model?: string };
    lastGenerationModel = body.model;
    return Response.json({
      created: 1717000000,
      data: [{ url: MOCK_URL }],
    });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    modelsCalls += 1;
    return Response.json({ object: "list", data: MOCK_MODELS.map((id) => ({ id, object: "model" })) });
  }
  return Response.json({ error: "not found" }, { status: 404 });
});

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...headers },
    body,
  });
  const res = await mcpHandler.fetch(req);
  return { status: res.status, text: await res.text() };
}

function resultOf(raw: string): unknown {
  const data = raw.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return data ? JSON.parse(data) : JSON.parse(raw);
}

interface RpcResult {
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
  };
  error?: { message?: string };
}

const BASE = "http://127.0.0.1:8788/mcp";
const HEADERS = {
  "X-OpenAI-Api-Key": "test-key-123",
  "X-OpenAI-Base-Url": "http://127.0.0.1:8788/v1",
};

async function main() {
  console.log("=== A. generate_image via headers ===");
  const call = await post(BASE, rpc(1, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a cute corgi astronaut", size: "1024x1024" },
  }), HEADERS);
  console.log(`status: ${call.status}`);
  const callResult = resultOf(call.text) as RpcResult;
  const text = callResult?.result?.content?.[0]?.text ?? "";
  console.log("markdown text:", JSON.stringify(text.slice(0, 200)));
  const structured = callResult?.result?.structuredContent as {
    model?: string;
    images?: { url?: string }[];
  } | undefined;
  if (structured?.images?.[0]?.url !== MOCK_URL) {
    throw new Error(`FAIL: expected url ${MOCK_URL}, got ${JSON.stringify(structured?.images)}`);
  }
  if (structured?.model !== "dall-e-3") {
    throw new Error(`FAIL: expected model 'dall-e-3' auto-selected from /models, got ${structured?.model}`);
  }
  if (lastGenerationModel !== "dall-e-3") {
    throw new Error(`FAIL: generation request should use the auto-selected model, got ${lastGenerationModel}`);
  }
  console.log("structuredContent:", JSON.stringify(structured));

  console.log("\n=== B. generate_image via URL query params ===");
  const qs = `?api_key=test-key-123&base_url=${encodeURIComponent("http://127.0.0.1:8788/v1")}`;
  const callQs = await post(BASE + qs, rpc(2, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a cute corgi astronaut" },
  }));
  console.log(`status: ${callQs.status}`);
  const structuredQs = resultOf(callQs.text) as RpcResult;
  const qsImages = structuredQs?.result?.structuredContent as { images?: { url?: string }[] } | undefined;
  if (qsImages?.images?.[0]?.url !== MOCK_URL) {
    throw new Error(`FAIL: query-param variant, got ${JSON.stringify(qsImages?.images)}`);
  }
  console.log("query-param variant OK:", JSON.stringify(qsImages));

  console.log("\n=== C. generate_image via Authorization: Bearer ===");
  const callAuth = await post(BASE, rpc(3, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a cute corgi astronaut" },
  }), { "Authorization": "Bearer test-key-123", "X-OpenAI-Base-Url": "http://127.0.0.1:8788/v1" });
  console.log(`status: ${callAuth.status}`);
  const authImages = resultOf(callAuth.text) as RpcResult;
  const authStructured = authImages?.result?.structuredContent as { images?: { url?: string }[] } | undefined;
  if (authStructured?.images?.[0]?.url !== MOCK_URL) {
    throw new Error(`FAIL: Authorization variant, got ${JSON.stringify(authStructured?.images)}`);
  }
  console.log("Authorization variant OK");
  // A, B, C all share the same base URL, so /models should only have been queried once (model remembered).
  if (modelsCalls !== 1) {
    throw new Error(`FAIL: expected /models queried once (remembered model reused), got ${modelsCalls} calls`);
  }
  console.log(`/models called ${modelsCalls} time(s) so far — remembered model reused ✅`);

  console.log("\n=== D. list_models via headers ===");
  const models = await post(BASE, rpc(4, "tools/call", { name: "list_models", arguments: {} }), HEADERS);
  console.log(`status: ${models.status}`);
  const modelsResult = resultOf(models.text) as RpcResult;
  console.log("models:", JSON.stringify(modelsResult?.result?.structuredContent));

  console.log("\n=== E. missing API key -> helpful error ===");
  const noKey = await post(BASE, rpc(5, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a cute corgi astronaut" },
  }));
  console.log(`status: ${noKey.status}`);
  const noKeyResult = resultOf(noKey.text) as RpcResult;
  const noKeyText = noKeyResult?.result?.content?.[0]?.text ?? "";
  console.log("message:", JSON.stringify(noKeyText.slice(0, 120)));
  if (!noKeyText.includes("No API key provided")) {
    throw new Error("FAIL: expected 'No API key provided' error");
  }

  console.log("\n=== F. list_images (blob storage — only on Val Town) ===");
  const listImgs = await post(BASE, rpc(6, "tools/call", { name: "list_images", arguments: {} }));
  console.log(`status: ${listImgs.status}`);
  const listImgsResult = resultOf(listImgs.text) as RpcResult;
  const listImgsText = listImgsResult?.result?.content?.[0]?.text ?? "";
  console.log("message:", JSON.stringify(listImgsText.slice(0, 160)));
  if (!/Val Town/i.test(listImgsText)) {
    throw new Error(`FAIL: expected a message about Val Town blob storage, got ${listImgsText}`);
  }

  console.log("\n=== G. remember last-used model ===");
  // Explicitly set a different model, then call again without `model` → it must reuse the remembered one.
  const modelsBefore = modelsCalls;
  const g1 = await post(BASE, rpc(7, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a rocket", model: "flux-1.1-pro" },
  }), HEADERS);
  const g1Result = resultOf(g1.text) as RpcResult;
  const g1Model = (g1Result?.result?.structuredContent as { model?: string } | undefined)?.model;
  if (g1Model !== "flux-1.1-pro") {
    throw new Error(`FAIL: explicit model not used, got ${g1Model}`);
  }
  const g2 = await post(BASE, rpc(8, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a moon" },
  }), HEADERS);
  const g2Result = resultOf(g2.text) as RpcResult;
  const g2Model = (g2Result?.result?.structuredContent as { model?: string } | undefined)?.model;
  if (g2Model !== "flux-1.1-pro") {
    throw new Error(`FAIL: expected remembered model flux-1.1-pro, got ${g2Model}`);
  }
  if (modelsCalls !== modelsBefore) {
    throw new Error(`FAIL: remembered model should avoid re-querying /models, got ${modelsCalls} calls (before: ${modelsBefore})`);
  }
  console.log("remembered model reused:", g2Model, "(/models not re-queried) ✅");

  console.log("\nAll checks passed. ✅");
  mock.shutdown();
}

try {
  await main();
} catch (err) {
  console.error(String(err));
  mock.shutdown();
  Deno.exit(1);
}
