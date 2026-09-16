/**
 * MCP Image Generation Server — Node.js thuần (không Val Town / Deno)
 * Chạy:
 *   npm install
 *   node main.js              # HTTP http://127.0.0.1:3000/mcp
 *   node main.js --stdio      # STDIO cho Claude Desktop
 *   PORT=3000 OPENAI_API_KEY=sk-... node main.js
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";

// ---- config ----
const SERVER_NAME = "imagen-mcp";
const SERVER_VERSION = "2.2.0";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "dall-e-3";
const AGNES_DEFAULT_IMAGE_MODEL = "agnes-image-2.1-flash";
const AGNES_DEFAULT_IMAGE_SIZE = "1024x1024";

// ---- helpers ----
function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function isAgnesApiBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "apihub.agnes-ai.com" || hostname === "apihub.agnes-ai.cn" || hostname === "api.agnes-ai.cn";
  } catch {
    return false;
  }
}

function normalizeProviderBaseUrl(baseUrl) {
  const clean = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!isAgnesApiBaseUrl(clean)) return clean;
  try {
    const url = new URL(clean);
    if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return clean;
  }
}

function collectIndexedProviders(req) {
  const providers = {};
  const basePrefixes = ["x-base-url-", "x-openai-base-url-"];
  const keyPrefixes = ["x-api-key-", "x-openai-api-key-"];
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = String(name).toLowerCase();
    const v = Array.isArray(value) ? value[0] ?? "" : String(value ?? "");
    for (const prefix of basePrefixes) {
      if (lower.startsWith(prefix)) {
        const idx = lower.slice(prefix.length);
        if (/^\d+$/.test(idx)) {
          const pv = providers[idx] ?? { baseUrl: "", apiKey: "" };
          pv.baseUrl = normalizeProviderBaseUrl(v.trim());
          providers[idx] = pv;
        }
      }
    }
    for (const prefix of keyPrefixes) {
      if (lower.startsWith(prefix)) {
        const idx = lower.slice(prefix.length);
        if (/^\d+$/.test(idx)) {
          const pv = providers[idx] ?? { baseUrl: "", apiKey: "" };
          pv.apiKey = v.trim();
          providers[idx] = pv;
        }
      }
    }
  }
  for (const key of Object.keys(providers)) {
    if (!providers[key].baseUrl || !providers[key].apiKey) delete providers[key];
  }
  return providers;
}

function extractConfig(req) {
  const host = getHeader(req, "host") || "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);

  let apiKey = getHeader(req, "x-api-key") || getHeader(req, "x-openai-api-key") || url.searchParams.get("apiKey") || "";
  if (!apiKey) {
    const auth = getHeader(req, "authorization");
    if (auth.startsWith("Bearer ")) apiKey = auth.slice(7).trim();
  }
  if (!apiKey) apiKey = process.env.OPENAI_API_KEY ?? process.env.X_OPENAI_API_KEY ?? "";

  let baseUrl = getHeader(req, "x-base-url") || getHeader(req, "x-openai-base-url") || url.searchParams.get("baseUrl") || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const defaultModel = String(url.searchParams.get("defaultModel") || "").trim();

  const providers = collectIndexedProviders(req);
  const selectedIndex = getHeader(req, "x-provider") || url.searchParams.get("provider") || "";
  if (selectedIndex && providers[selectedIndex]) {
    baseUrl = providers[selectedIndex].baseUrl;
    apiKey = providers[selectedIndex].apiKey;
  }

  return {
    apiKey: String(apiKey).trim(),
    baseUrl: normalizeProviderBaseUrl(baseUrl),
    ...(Object.keys(providers).length ? { providers } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  };
}


const DEFAULT_STORAGE_BUCKET = "imagen-mcp-generated";

function getSupabaseServiceKey() {
  const plain = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (plain) return plain;
  const json = process.env.SUPABASE_SECRET_KEYS;
  if (!json) return "";
  try {
    const keys = JSON.parse(json);
    return typeof keys?.default === "string" ? keys.default.trim() : "";
  } catch {
    return "";
  }
}

function getSupabaseStorageConfig() {
  const url = String(process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const serviceKey = getSupabaseServiceKey();
  const bucket = String(process.env.SUPABASE_STORAGE_BUCKET ?? DEFAULT_STORAGE_BUCKET).trim();
  return url && serviceKey && bucket ? { url, serviceKey, bucket } : null;
}

function storageHeaders(serviceKey, contentType) {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function storageObjectPath(bucket, objectPath) {
  const encodedBucket = encodeURIComponent(bucket);
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  return { encodedBucket, encodedPath };
}

async function ensureStorageBucket(config) {
  const encodedBucket = encodeURIComponent(config.bucket);
  const getBucket = async () => fetch(`${config.url}/storage/v1/bucket/${encodedBucket}`, {
    headers: storageHeaders(config.serviceKey),
  });

  let res = await getBucket();
  if (res.ok) {
    const info = await res.json().catch(() => ({}));
    return Boolean(info?.public);
  }
  if (res.status !== 404) {
    throw new Error(`Supabase Storage bucket check failed (HTTP ${res.status}): ${await res.text()}`);
  }

  const create = await fetch(`${config.url}/storage/v1/bucket`, {
    method: "POST",
    headers: storageHeaders(config.serviceKey, "application/json"),
    body: JSON.stringify({ id: config.bucket, name: config.bucket, public: true }),
  });
  if (create.ok) return true;
  if (create.status !== 409) {
    throw new Error(`Supabase Storage bucket creation failed (HTTP ${create.status}): ${await create.text()}`);
  }

  res = await getBucket();
  if (!res.ok) {
    throw new Error(`Supabase Storage bucket check failed after create race (HTTP ${res.status}): ${await res.text()}`);
  }
  const info = await res.json().catch(() => ({}));
  return Boolean(info?.public);
}

function decodeBase64Image(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageOutputFormat(args) {
  const format = typeof args.extra?.output_format === "string" ? args.extra.output_format.toLowerCase() : "png";
  if (format === "jpeg" || format === "jpg") return { extension: "jpg", contentType: "image/jpeg" };
  if (format === "webp") return { extension: "webp", contentType: "image/webp" };
  return { extension: "png", contentType: "image/png" };
}

function parseBase64ImageDataUrl(value) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(value).trim());
  if (!match) return null;
  return { contentType: match[1].toLowerCase(), base64: match[2] };
}

async function uploadBase64ImageToSupabase(b64, model, args, explicitContentType) {
  const config = getSupabaseStorageConfig();
  if (!config) {
    throw new Error("Supabase Storage fallback is not configured. SUPABASE_URL and a Supabase secret/service-role key are required when the provider only returns base64 image data.");
  }

  const isPublic = await ensureStorageBucket(config);
  const inferred = imageOutputFormat(args);
  const contentType = explicitContentType ?? inferred.contentType;
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  const safeModel = String(model).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100) || "model";
  const objectPath = `${safeModel}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const { encodedBucket, encodedPath } = storageObjectPath(config.bucket, objectPath);

  const upload = await fetch(`${config.url}/storage/v1/object/${encodedBucket}/${encodedPath}`, {
    method: "POST",
    headers: {
      ...storageHeaders(config.serviceKey, contentType),
      "x-upsert": "false",
    },
    body: decodeBase64Image(b64),
  });
  if (!upload.ok) {
    throw new Error(`Supabase Storage upload failed (HTTP ${upload.status}): ${await upload.text()}`);
  }

  if (isPublic) {
    return `${config.url}/storage/v1/object/public/${encodedBucket}/${encodedPath}`;
  }

  const sign = await fetch(`${config.url}/storage/v1/object/sign/${encodedBucket}/${encodedPath}`, {
    method: "POST",
    headers: storageHeaders(config.serviceKey, "application/json"),
    body: JSON.stringify({ expiresIn: 604800 }),
  });
  if (!sign.ok) {
    throw new Error(`Supabase Storage signed URL creation failed (HTTP ${sign.status}): ${await sign.text()}`);
  }
  const signed = await sign.json();
  if (typeof signed?.signedURL !== "string" || !signed.signedURL) {
    throw new Error("Supabase Storage did not return a signed URL.");
  }
  return new URL(signed.signedURL, `${config.url}/`).toString();
}

// ---- image-model detection / auto-select ----
// Curated known image-generation families; delimiter-aware to avoid broad false positives.
const IMAGE_MODEL_REGEX = /(?:^|[\/:._-])(?:gpt[-._]?image|chatgpt[-._]?image|dall[-._]?e|imagen|gemini[-._][a-z0-9._-]*[-._]image|flux(?:[-._]?\d+(?:\.\d+)*)?|stable[-._]?(?:diffusion|image)|sdxl|sd3(?:[-._]?\d+(?:\.\d+)*)?|qwen[-._]?image|wan(?:[-._]?\d+(?:\.\d+)*)?[-._]?(?:image|t2i|i2i)|z[-._]?image|ideogram|recraft|seedream|hidream|midjourney|firefly[-._]?image|sana|playground|photon|auraflow|pixart|kolors|cogview|hunyuan[-._]?image)(?=$|[\/:._-])/i;
function looksImageCapable(id) { return IMAGE_MODEL_REGEX.test(id); }

async function pickModel(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return { model: DEFAULT_MODEL, warning: `Could not list models (HTTP ${res.status}); using fallback "${DEFAULT_MODEL}".` };
    const data = await res.json();
    const ids = (data.data ?? []).map(m => m.id).filter(id => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { model: DEFAULT_MODEL, warning: `No models returned; using fallback "${DEFAULT_MODEL}".` };
    const imageModels = ids.filter(looksImageCapable);
    if (imageModels.length === 0) return { model: DEFAULT_MODEL, warning: `No known image-generation model matched /models; using fallback "${DEFAULT_MODEL}".` };
    return { model: imageModels[0] };
  } catch (err) {
    return { model: DEFAULT_MODEL, warning: `Could not reach /models (${String(err)}); using fallback "${DEFAULT_MODEL}".` };
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function buildImageGenerationBody(config, args, model) {
  const isAgnes = isAgnesApiBaseUrl(config.baseUrl);
  const body = { model, prompt: args.prompt, n: args.n ?? 1 };

  if (isAgnes) {
    body.size = args.size && args.size !== "auto" ? args.size : AGNES_DEFAULT_IMAGE_SIZE;
    const extra = { ...(args.extra ?? {}) };
    const extraBody = { ...(asRecord(extra.extra_body) ?? {}) };
    delete extra.extra_body;
    if ("image" in extra) {
      if (!("image" in extraBody)) extraBody.image = extra.image;
      delete extra.image;
    }
    if ("response_format" in extra) {
      if (!("response_format" in extraBody)) extraBody.response_format = extra.response_format;
      delete extra.response_format;
    }
    if (!("response_format" in extraBody) && extra.return_base64 !== true) extraBody.response_format = "url";
    Object.assign(body, extra);
    body.extra_body = extraBody;
    return body;
  }

  if (!/^(?:gpt[-._]?image|chatgpt[-._]?image)/i.test(model)) body.response_format = "url";
  if (args.size && args.size !== "auto") body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.style) body.style = args.style;
  if (args.extra && typeof args.extra === "object") Object.assign(body, args.extra);
  return body;
}

// ---- core ----
async function generateImages(config, args) {
  const isAgnes = isAgnesApiBaseUrl(config.baseUrl);
  let model = args.model ?? config.defaultModel ?? (isAgnes ? AGNES_DEFAULT_IMAGE_MODEL : undefined);
  let modelNote;
  if (!model) {
    const picked = await pickModel(config.baseUrl, config.apiKey);
    model = picked.model;
    modelNote = picked.warning;
  }

  const body = buildImageGenerationBody(config, args, model);

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: normalizeProviderBaseUrl(config.baseUrl) });
  let data;
  try {
    data = await client.images.generate(body);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
    const detail = err instanceof Error ? err.message : String(err);
    const label = typeof status === "number" ? `Image API error (HTTP ${status})` : "Image API error";
    return { content: [{ type: "text", text: `${label}:\n${detail}` }], isError: true };
  }

  const images = Array.isArray(data.data) ? data.data : [];
  const markdownLines = [];
  if (modelNote) markdownLines.push(`> ${modelNote}`);
  markdownLines.push(`Generated ${images.length} image(s) with model **${model}**.`);
  const structuredImages = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i] ?? {};
    const entry = { index: i };
    if (typeof img.url === "string" && img.url) {
      const dataUrl = parseBase64ImageDataUrl(img.url);
      if (dataUrl) {
        try {
          const url = await uploadBase64ImageToSupabase(dataUrl.base64, model, args, dataUrl.contentType);
          entry.url = url;
          markdownLines.push(`Image ${i+1}: ${url}`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Image storage fallback failed: ${detail}` }], isError: true };
        }
      } else {
        entry.url = img.url;
        markdownLines.push(`Image ${i+1}: ${img.url}`);
      }
    } else if (typeof img.b64_json === "string" && img.b64_json) {
      try {
        const url = await uploadBase64ImageToSupabase(img.b64_json, model, args);
        entry.url = url;
        markdownLines.push(`Image ${i+1}: ${url}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Image storage fallback failed: ${detail}` }], isError: true };
      }
    } else {
      return { content: [{ type: "text", text: `Image API returned neither a URL nor base64 image data for model **${model}**.` }], isError: true };
    }
    structuredImages.push(entry);
  }
  return { content: [{ type: "text", text: markdownLines.join("\n\n") }], structuredContent: { model, created: data.created, images: structuredImages } };
}

// ---- MCP factory ----
function buildServer(config) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool("generate_image", {
    description: "Generate images via OpenAI-compatible API. Config via headers X-Api-Key / X-Base-Url (multiple providers via X-Api-Key-N / X-Base-Url-N + X-Provider: N), query ?apiKey=&baseUrl=&provider=, or env OPENAI_API_KEY/OPENAI_BASE_URL.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed text description of the image(s) to generate."),
      model: z.string().optional().describe("Optional model override. When omitted, defaultModel from the endpoint query string is used; Agnes endpoints default to agnes-image-2.1-flash; otherwise auto-select from GET /models."),
      size: z.enum(["256x256","512x512","1024x1024","1024x1792","1792x1024","auto"]).optional(),
      n: z.number().int().min(1).max(10).optional(),
      quality: z.enum(["standard","hd"]).optional(),
      style: z.enum(["vivid","natural"]).optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (args) => {
    if (!config.apiKey) return { content: [{ type: "text", text: "No API key. Pass X-Api-Key / Authorization: Bearer <key> / ?apiKey=..., or set OPENAI_API_KEY." }], isError: true };
    return await generateImages(config, args);
  });

  server.registerTool("list_models", {
    description: "List all models from GET {baseUrl}/models. Optionally filter model names by a keyword string; whitespace- or comma-separated terms are matched case-insensitively and all terms must be present.",
    inputSchema: z.object({
      keywords: z.string().optional().describe("Optional keywords used to filter model ids, e.g. 'gpt 5' or 'qwen,coder'."),
    }),
  }, async (args) => {
    if (!config.apiKey) return { content: [{ type: "text", text: "No API key. Pass X-Api-Key / Authorization: Bearer <key> / ?apiKey=..., or set OPENAI_API_KEY." }], isError: true };
    const res = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    if (!res.ok) return { content: [{ type: "text", text: `Models API error (HTTP ${res.status}): ${await res.text()}` }], isError: true };
    const data = await res.json();
    const allModels = (data.data ?? []).map(m => m.id).filter(id => typeof id === "string");
    const terms = String(args.keywords ?? "").toLowerCase().split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const models = terms.length ? allModels.filter(id => { const lower = id.toLowerCase(); return terms.every(term => lower.includes(term)); }) : allModels;
    const suffix = terms.length ? ` matching "${args.keywords}"` : "";
    return { content: [{ type: "text", text: models.length ? `Available models${suffix} (${models.length}):\n${models.join("\n")}` : `No models matched${suffix}.` }], structuredContent: { models } };
  });

  return server;
}

// ---- entry points ----
async function startStdio() {
  const config = { apiKey: process.env.OPENAI_API_KEY ?? process.env.X_OPENAI_API_KEY ?? "", baseUrl: (process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "") };
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] STDIO mode — baseUrl=${config.baseUrl} ${config.apiKey ? "(key set)" : "(no key — set OPENAI_API_KEY)"}`);
}

function startHttp() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const httpServer = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-Api-Key, X-Base-Url, X-Provider, X-OpenAI-Api-Key, X-OpenAI-Base-Url, mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, status: "ok" }));
      return;
    }
    if (url.pathname === "/" && req.method === "GET") {
      const accept = getHeader(req, "accept");
      if (!accept.includes("text/event-stream") && !accept.includes("application/json")) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(SERVER_NAME + " v" + SERVER_VERSION + "\nMCP Streamable HTTP: POST http://" + host + ":" + port + "/mcp\nHealth: GET http://" + host + ":" + port + "/health\nPass API key via X-Api-Key / Authorization: Bearer <key> / ?apiKey= or OPENAI_API_KEY env. Multiple providers: X-Base-Url-N / X-Api-Key-N + X-Provider: N.\n");
        return;
      }
    }
    const isMcpPath = url.pathname === "/mcp" || url.pathname === "/" || url.pathname === "/sse";
    if (!isMcpPath) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found. Use POST /mcp" })); return; }

    try {
      const config = extractConfig(req);
      const server = buildServer(config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp] handleRequest error:", err);
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(err) })); }
    }
  });
  httpServer.listen(port, host, () => {
    console.log(`[${SERVER_NAME} v${SERVER_VERSION}] HTTP listening on http://${host}:${port}/mcp`);
    console.log(`  Health: http://${host}:${port}/health`);
    console.log(`  Pass key per-request: X-Api-Key / Authorization: Bearer <key> / ?apiKey= (multiple providers: X-Base-Url-N / X-Api-Key-N + X-Provider: N)`);
  });
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
  if (process.argv.includes("--stdio")) await startStdio();
  else startHttp();
}

export { buildServer, extractConfig, pickModel, SERVER_NAME, SERVER_VERSION };
