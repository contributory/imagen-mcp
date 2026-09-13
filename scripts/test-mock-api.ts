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
 *   - list_models returns all models and supports keyword filtering
 *   - missing API key -> helpful error
 *   - stateless model auto-selection (re-queries /models when model is omitted)
 *   - base64-only image responses are uploaded to Supabase Storage and returned as URLs
 */

const STORAGE_BASE = "http://127.0.0.1:8788";
Deno.env.set("SUPABASE_URL", STORAGE_BASE);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("SUPABASE_STORAGE_BUCKET", "imagen-mcp-generated");

const { mcpHandler } = await import("../mcp-image-server.ts");

// ---- mock API + Supabase Storage server ----------------------------------
const MOCK_URL = "https://cdn.example.com/img-1.png";
const MOCK_BASE64 = btoa("SHOULD_NOT_LEAK_BASE64_IMAGE_DATA");
const MOCK_MODELS = ["gpt-5.6", "qwen3-coder-plus", "gemini-3-pro", "dall-e-3", "gpt-image-1", "flux-1.1-pro", "qwen-image-2.0", "recraft-v3"];

let lastGenerationModel: string | undefined;
let modelsCalls = 0;
let storageBucketCreated = false;
let storageUploadBytes = 0;
let storageUploadPath = "";
const mock = Deno.serve({ port: 8788, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/v1/images/generations") {
    const body = await req.json() as { model?: string };
    lastGenerationModel = body.model;
    if (typeof body.model === "string" && /^gpt-image/i.test(body.model)) {
      return Response.json({
        created: 1717000000,
        data: [{ b64_json: MOCK_BASE64 }],
      });
    }
    return Response.json({
      created: 1717000000,
      data: [{ url: MOCK_URL }],
    });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    modelsCalls += 1;
    return Response.json({ object: "list", data: MOCK_MODELS.map((id) => ({ id, object: "model" })) });
  }
  if (req.method === "GET" && url.pathname === "/storage/v1/bucket/imagen-mcp-generated") {
    return storageBucketCreated
      ? Response.json({ id: "imagen-mcp-generated", name: "imagen-mcp-generated", public: true })
      : Response.json({ message: "Bucket not found" }, { status: 404 });
  }
  if (req.method === "POST" && url.pathname === "/storage/v1/bucket") {
    const body = await req.json() as { id?: string; public?: boolean };
    if (body.id !== "imagen-mcp-generated" || body.public !== true) {
      return Response.json({ message: "bad bucket config" }, { status: 400 });
    }
    storageBucketCreated = true;
    return Response.json({ name: body.id });
  }
  if (req.method === "POST" && url.pathname.startsWith("/storage/v1/object/imagen-mcp-generated/")) {
    storageUploadPath = url.pathname;
    storageUploadBytes = (await req.arrayBuffer()).byteLength;
    return Response.json({ Key: url.pathname });
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
  const qs = `?apiKey=test-key-123&baseUrl=${encodeURIComponent("http://127.0.0.1:8788/v1")}`;
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
  // Stateless behavior: each call without an explicit model queries /models.
  if (modelsCalls !== 3) {
    throw new Error(`FAIL: expected /models queried once per generation without model, got ${modelsCalls} calls`);
  }
  console.log(`/models called ${modelsCalls} time(s) so far — stateless auto-selection ✅`);

  console.log("\n=== D. list_models all + keyword filtering ===");
  const allModelsCall = await post(BASE, rpc(5, "tools/call", { name: "list_models", arguments: {} }), HEADERS);
  const allModelsResult = resultOf(allModelsCall.text) as RpcResult;
  const allModels = (allModelsResult?.result?.structuredContent as { models?: string[] } | undefined)?.models ?? [];
  if (JSON.stringify(allModels) !== JSON.stringify(MOCK_MODELS)) {
    throw new Error(`FAIL: list_models should return all models, got ${JSON.stringify(allModels)}`);
  }

  const qwenModelsCall = await post(BASE, rpc(6, "tools/call", {
    name: "list_models",
    arguments: { keywords: "qwen" },
  }), HEADERS);
  const qwenModelsResult = resultOf(qwenModelsCall.text) as RpcResult;
  const qwenModels = (qwenModelsResult?.result?.structuredContent as { models?: string[] } | undefined)?.models ?? [];
  if (JSON.stringify(qwenModels) !== JSON.stringify(["qwen3-coder-plus", "qwen-image-2.0"])) {
    throw new Error(`FAIL: keyword filter qwen returned ${JSON.stringify(qwenModels)}`);
  }

  const qwenImageCall = await post(BASE, rpc(7, "tools/call", {
    name: "list_models",
    arguments: { keywords: "qwen image" },
  }), HEADERS);
  const qwenImageResult = resultOf(qwenImageCall.text) as RpcResult;
  const qwenImageModels = (qwenImageResult?.result?.structuredContent as { models?: string[] } | undefined)?.models ?? [];
  if (JSON.stringify(qwenImageModels) !== JSON.stringify(["qwen-image-2.0"])) {
    throw new Error(`FAIL: multi-keyword filter returned ${JSON.stringify(qwenImageModels)}`);
  }
  console.log("list_models all + keyword filters OK");

  console.log("\n=== E. missing API key -> helpful error ===");
  const noKey = await post(BASE, rpc(8, "tools/call", {
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

  console.log("\n=== F. explicit model is not persisted ===");
  const modelsBefore = modelsCalls;
  const g1 = await post(BASE, rpc(9, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a rocket", model: "flux-1.1-pro" },
  }), HEADERS);
  const g1Result = resultOf(g1.text) as RpcResult;
  const g1Model = (g1Result?.result?.structuredContent as { model?: string } | undefined)?.model;
  if (g1Model !== "flux-1.1-pro") {
    throw new Error(`FAIL: explicit model not used, got ${g1Model}`);
  }
  if (modelsCalls !== modelsBefore) {
    throw new Error(`FAIL: explicit model should not call /models, got ${modelsCalls - modelsBefore} extra calls`);
  }

  const g2 = await post(BASE, rpc(10, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a moon" },
  }), HEADERS);
  const g2Result = resultOf(g2.text) as RpcResult;
  const g2Model = (g2Result?.result?.structuredContent as { model?: string } | undefined)?.model;
  if (g2Model !== "dall-e-3") {
    throw new Error(`FAIL: expected fresh auto-selection to choose dall-e-3, got ${g2Model}`);
  }
  if (modelsCalls !== modelsBefore + 1) {
    throw new Error(`FAIL: omitted model should re-query /models exactly once, got ${modelsCalls - modelsBefore} calls`);
  }
  console.log("explicit model was not persisted; next omitted model re-queried /models ✅");

  console.log("\n=== G. base64-only provider is uploaded to Supabase Storage ===");
  const base64Only = await post(BASE, rpc(11, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "a cat", model: "gpt-image-1" },
  }), HEADERS);
  const base64Result = resultOf(base64Only.text) as RpcResult;
  const base64Text = base64Result?.result?.content?.[0]?.text ?? "";
  const storedImages = (base64Result?.result?.structuredContent as { images?: { url?: string }[] } | undefined)?.images ?? [];
  const storedUrl = storedImages[0]?.url ?? "";
  if (!storedUrl.startsWith(`${STORAGE_BASE}/storage/v1/object/public/imagen-mcp-generated/gpt-image-1/`)) {
    throw new Error(`FAIL: expected Supabase Storage public URL, got ${storedUrl}`);
  }
  if (!base64Text.includes(storedUrl)) {
    throw new Error(`FAIL: response text should contain stored URL, got ${base64Text}`);
  }
  if (base64Only.text.includes(MOCK_BASE64) || base64Only.text.includes("SHOULD_NOT_LEAK_BASE64_IMAGE_DATA")) {
    throw new Error("FAIL: base64 image content leaked into MCP response");
  }
  if (!storageBucketCreated || storageUploadBytes <= 0 || !storageUploadPath.includes("/gpt-image-1/")) {
    throw new Error(`FAIL: storage fallback did not create/upload correctly: created=${storageBucketCreated} bytes=${storageUploadBytes} path=${storageUploadPath}`);
  }
  console.log("base64 uploaded to Supabase Storage; URL returned without leaking image data ✅");

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
