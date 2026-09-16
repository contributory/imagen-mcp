/**
 * ============================================================================
 * MCP Image Generation Server (imagen-mcp)
 * ----------------------------------------------------------------------------
 * An MCP (Model Context Protocol) server that generates images through any
 * OpenAI-compatible image API (OpenAI DALL·E, gpt-image-1, Groq, Together,
 * OpenRouter, local vLLM / LiteLLM, ...).
 *
 * Runs on Deno and is designed to be deployed as a Val Town HTTP val.
 *
 * UPSTREAM API CREDENTIALS ARE PER REQUEST — the OpenAI-compatible API base URL
 * and API key are supplied by the MCP client via HTTP headers or URL query
 * parameters. Supabase deployments additionally use platform-provided env vars
 * for Queue/Storage administration:
 *
 *   Headers:
 *     X-Api-Key: <api key>                        (required)
 *     X-Base-Url: https://api.openai.com/v1       (optional)
 *
 *   Multiple upstream providers can be registered on a single request using
 *   indexed headers (base URL + API key for each index N >= 1):
 *       X-Base-Url-1 / X-Api-Key-1
 *       X-Base-Url-2 / X-Api-Key-2
 *       ...
 *   Pick which registered provider a call should use with:
 *       X-Provider: <N>      (or as a query param: ?provider=<N>)
 *   When X-Provider is omitted or unknown, the primary X-Api-Key /
 *   X-Base-Url config is used.
 *   The legacy X-OpenAI-* header names remain accepted for backwards compat.
 *   Alternative for the key:  Authorization: Bearer <api key>
 *   Or as URL query params:   ?apiKey=...&baseUrl=...&defaultModel=...
 *
 *   `defaultModel` can be supplied as a query parameter. The `model` tool
 *   argument overrides it per call; otherwise the server falls back to model
 *   auto-selection from GET {baseUrl}/models.
 *
 * DEPLOY ON VAL TOWN
 *   1. Create a new HTTP val (or open the file in the Val Town editor) and
 *      paste this file's content.
 *   2. Add the HTTP trigger and save — your endpoint is live at
 *      https://<user>-<val>.web.val.run
 *   3. Point any MCP client (Claude Desktop, Cursor, Copilot, ...) at that URL
 *      using the "Streamable HTTP" transport, passing the headers / query
 *      params above.
 * ============================================================================
 */

import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server";
import { z } from "npm:zod@4";
import OpenAI from "npm:openai";
import type { ImageGenerateParamsNonStreaming } from "npm:openai/resources/images";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "imagen-mcp";
const SERVER_VERSION = "2.2.0";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Last-resort fallback, only used if GET {baseUrl}/models cannot be reached.
const DEFAULT_MODEL = "dall-e-3";
const AGNES_DEFAULT_IMAGE_MODEL = "agnes-image-2.1-flash";
const AGNES_DEFAULT_IMAGE_SIZE = "1024x1024";

// ---------------------------------------------------------------------------
// Per-request configuration (headers / query params)
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ServerConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  /** Additional upstream providers keyed by numeric index (e.g. "1", "2"). */
  providers?: Record<string, ProviderConfig>;
}

/** Detect Agnes by its documented API hosts, not by prompt/model content. */
export function isAgnesApiBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "apihub.agnes-ai.com" ||
      hostname === "apihub.agnes-ai.cn" ||
      hostname === "api.agnes-ai.cn";
  } catch {
    return false;
  }
}

/** Agnes accepts a host-only base URL, but the OpenAI SDK needs the /v1 prefix. */
export function normalizeProviderBaseUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (!isAgnesApiBaseUrl(clean)) return clean;
  try {
    const url = new URL(clean);
    if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return clean;
  }
}

/** Read a value from a header first, then from a URL query parameter. */
function headerOrParam(
  headers: Headers,
  headerName: string,
  params: URLSearchParams,
  paramName: string,
  fallback = "",
): string {
  const fromHeader = headers.get(headerName);
  if (fromHeader) return fromHeader.trim();
  const fromParam = params.get(paramName);
  if (fromParam) return fromParam.trim();
  return fallback;
}

/** Collect indexed upstream providers (base URL + API key) from headers. */
function collectIndexedProviders(headers: Headers): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  const basePrefixes = ["x-base-url-", "x-openai-base-url-"];
  const keyPrefixes = ["x-api-key-", "x-openai-api-key-"];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    for (const prefix of basePrefixes) {
      if (lower.startsWith(prefix)) {
        const idx = lower.slice(prefix.length);
        if (/^\d+$/.test(idx)) {
          const pv = providers[idx] ?? { baseUrl: "", apiKey: "" };
          pv.baseUrl = normalizeProviderBaseUrl(value.trim());
          providers[idx] = pv;
        }
      }
    }
    for (const prefix of keyPrefixes) {
      if (lower.startsWith(prefix)) {
        const idx = lower.slice(prefix.length);
        if (/^\d+$/.test(idx)) {
          const pv = providers[idx] ?? { baseUrl: "", apiKey: "" };
          pv.apiKey = value.trim();
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

/** Extract base URL / API key from the request headers or query params. */
function extractConfig(req: Request): ServerConfig {
  const url = new URL(req.url);
  const headers = req.headers;

  // Primary API key: X-Api-Key header, then legacy X-OpenAI-Api-Key, then a
  // query param, then Authorization: Bearer.
  let apiKey = headerOrParam(headers, "x-api-key", url.searchParams, "apiKey");
  if (!apiKey) apiKey = headerOrParam(headers, "x-openai-api-key", url.searchParams, "apiKey");
  if (!apiKey) {
    const auth = headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) apiKey = auth.slice(7).trim();
  }

  // Primary base URL: X-Base-Url header, then legacy X-OpenAI-Base-Url, then
  // a query param.
  let baseUrl = headerOrParam(headers, "x-base-url", url.searchParams, "baseUrl");
  if (!baseUrl) baseUrl = headerOrParam(headers, "x-openai-base-url", url.searchParams, "baseUrl", DEFAULT_BASE_URL);

  // Additional upstream providers registered via indexed headers.
  const providers = collectIndexedProviders(headers);

  // Provider selection: X-Provider header or ?provider= (index of a registered
  // indexed provider). Falls back to the primary config when unspecified or
  // unknown.
  const selectedIndex = headerOrParam(headers, "x-provider", url.searchParams, "provider").trim();
  if (providers[selectedIndex]) {
    baseUrl = providers[selectedIndex].baseUrl;
    apiKey = providers[selectedIndex].apiKey;
  }

  const defaultModel = (url.searchParams.get("defaultModel") ?? "").trim();

  return {
    apiKey,
    baseUrl: normalizeProviderBaseUrl(baseUrl),
    ...(Object.keys(providers).length ? { providers } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible image generation
// ---------------------------------------------------------------------------

interface GeneratedImage {
  url?: string;
  b64_json?: string;
}



const DEFAULT_STORAGE_BUCKET = "imagen-mcp-generated";

interface SupabaseStorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

function getSupabaseServiceKey(): string {
  const plain = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "").trim();
  if (plain) return plain;
  const json = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!json) return "";
  try {
    const keys = JSON.parse(json) as Record<string, unknown>;
    for (const name of ["service_role", "serviceRole", "secret", "default"]) {
      const value = keys[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    for (const value of Object.values(keys)) {
      if (typeof value === "string" && value.startsWith("sb_secret_") && value.trim()) return value.trim();
    }
    return "";
  } catch {
    return "";
  }
}

function getSupabaseStorageConfig(): SupabaseStorageConfig | null {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const serviceKey = getSupabaseServiceKey();
  const bucket = (Deno.env.get("SUPABASE_STORAGE_BUCKET") ?? DEFAULT_STORAGE_BUCKET).trim();
  return url && serviceKey && bucket ? { url, serviceKey, bucket } : null;
}

interface SupabaseAdminConfig {
  url: string;
  serviceKey: string;
}

function getSupabaseAdminConfig(): SupabaseAdminConfig | null {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const serviceKey = getSupabaseServiceKey();
  return url && serviceKey ? { url, serviceKey } : null;
}

function supabaseAdminHeaders(serviceKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "Content-Type": "application/json",
  };
}

async function supabaseRpc<T>(functionName: string, body: Record<string, unknown>): Promise<T> {
  const config = getSupabaseAdminConfig();
  if (!config) throw new Error("Supabase queue is not configured.");
  const res = await fetch(`${config.url}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: supabaseAdminHeaders(config.serviceKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase RPC ${functionName} failed (HTTP ${res.status}): ${await res.text()}`);
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

async function enqueueImageJob(
  jobId: string,
  request: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<number> {
  return await supabaseRpc<number>("imagen_enqueue_image_job", {
    p_job_id: jobId,
    p_request: request,
    p_payload: payload,
  });
}

interface ImageJobRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: "queued" | "processing" | "completed" | "failed";
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
}

async function getImageJob(jobId: string): Promise<ImageJobRow | null> {
  const config = getSupabaseAdminConfig();
  if (!config) throw new Error("Supabase queue is not configured.");
  const query = new URLSearchParams({
    id: `eq.${jobId}`,
    select: "id,created_at,updated_at,status,request,result,error,attempts",
    limit: "1",
  });
  const res = await fetch(`${config.url}/rest/v1/image_jobs?${query}`, {
    headers: supabaseAdminHeaders(config.serviceKey),
  });
  if (!res.ok) throw new Error(`Supabase image job lookup failed (HTTP ${res.status}): ${await res.text()}`);
  const rows = await res.json() as ImageJobRow[];
  return rows[0] ?? null;
}

async function kickImageWorker(): Promise<{ ok: boolean; detail?: string }> {
  const config = getSupabaseAdminConfig();
  if (!config) return { ok: false, detail: "Supabase queue is not configured." };
  try {
    const res = await fetch(`${config.url}/functions/v1/imagen-mcp-worker`, {
      method: "POST",
      headers: supabaseAdminHeaders(config.serviceKey),
      body: JSON.stringify({ source: "imagen-mcp" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `worker HTTP ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function storageHeaders(serviceKey: string, contentType?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function storageObjectPath(bucket: string, objectPath: string): { encodedBucket: string; encodedPath: string } {
  return {
    encodedBucket: encodeURIComponent(bucket),
    encodedPath: objectPath.split("/").map(encodeURIComponent).join("/"),
  };
}

async function ensureStorageBucket(config: SupabaseStorageConfig): Promise<boolean> {
  const encodedBucket = encodeURIComponent(config.bucket);
  const getBucket = () => fetch(`${config.url}/storage/v1/bucket/${encodedBucket}`, {
    headers: storageHeaders(config.serviceKey),
  });

  let res = await getBucket();
  if (res.ok) {
    const info = await res.json().catch(() => ({})) as { public?: boolean };
    return Boolean(info.public);
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
  const info = await res.json().catch(() => ({})) as { public?: boolean };
  return Boolean(info.public);
}

function decodeBase64Image(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageOutputFormat(args: { extra?: Record<string, unknown> }): { extension: string; contentType: string } {
  const format = typeof args.extra?.output_format === "string" ? args.extra.output_format.toLowerCase() : "png";
  if (format === "jpeg" || format === "jpg") return { extension: "jpg", contentType: "image/jpeg" };
  if (format === "webp") return { extension: "webp", contentType: "image/webp" };
  return { extension: "png", contentType: "image/png" };
}

function parseBase64ImageDataUrl(value: string): { contentType: string; base64: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) return null;
  return { contentType: match[1].toLowerCase(), base64: match[2] };
}

async function uploadBase64ImageToSupabase(
  b64: string,
  model: string,
  args: { extra?: Record<string, unknown> },
  explicitContentType?: string,
): Promise<string> {
  const config = getSupabaseStorageConfig();
  if (!config) {
    throw new Error(
      "Supabase Storage fallback is not configured. SUPABASE_URL and a Supabase secret/service-role key are required when the provider only returns base64 image data.",
    );
  }

  const isPublic = await ensureStorageBucket(config);
  const inferred = imageOutputFormat(args);
  const contentType = explicitContentType ?? inferred.contentType;
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100) || "model";
  const objectPath = `${safeModel}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const { encodedBucket, encodedPath } = storageObjectPath(config.bucket, objectPath);

  const bytes = decodeBase64Image(b64);
  const uploadBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const upload = await fetch(`${config.url}/storage/v1/object/${encodedBucket}/${encodedPath}`, {
    method: "POST",
    headers: {
      ...storageHeaders(config.serviceKey, contentType),
      "x-upsert": "false",
    },
    body: uploadBody,
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
  const signed = await sign.json() as { signedURL?: string };
  if (!signed.signedURL) throw new Error("Supabase Storage did not return a signed URL.");
  return new URL(signed.signedURL, `${config.url}/`).toString();
}

// ---------------------------------------------------------------------------
// Model auto-selection via GET {baseUrl}/models
// ---------------------------------------------------------------------------

/** Curated known image-generation families; delimiter-aware to avoid broad false positives. */
const IMAGE_MODEL_REGEX = /(?:^|[\/:._-])(?:gpt[-._]?image|chatgpt[-._]?image|dall[-._]?e|imagen|gemini[-._][a-z0-9._-]*[-._]image|flux(?:[-._]?\d+(?:\.\d+)*)?|stable[-._]?(?:diffusion|image)|sdxl|sd3(?:[-._]?\d+(?:\.\d+)*)?|qwen[-._]?image|wan(?:[-._]?\d+(?:\.\d+)*)?[-._]?(?:image|t2i|i2i)|z[-._]?image|ideogram|recraft|seedream|hidream|midjourney|firefly[-._]?image|sana|playground|photon|auraflow|pixart|kolors|cogview|hunyuan[-._]?image)(?=$|[\/:._-])/i;

/** Best-effort classification of an image-generation model id. */
function looksImageCapable(id: string): boolean {
  return IMAGE_MODEL_REGEX.test(id);
}

interface ModelPick {
  model: string;
  warning?: string;
}

/**
 * Pick a model by querying GET {baseUrl}/models and filtering through the
 * curated image-model regex. Falls back to DEFAULT_MODEL if none match.
 */
async function pickModel(baseUrl: string, apiKey: string): Promise<ModelPick> {
  const endpoint = `${baseUrl}/models`;
  try {
    const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      return {
        model: DEFAULT_MODEL,
        warning: `Could not list models (HTTP ${res.status}); using fallback model "${DEFAULT_MODEL}".`,
      };
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      return { model: DEFAULT_MODEL, warning: `No models returned by /models; using fallback model "${DEFAULT_MODEL}".` };
    }
    const imageModels = ids.filter(looksImageCapable);
    if (imageModels.length === 0) {
      return { model: DEFAULT_MODEL, warning: `No known image-generation model matched /models; using fallback model "${DEFAULT_MODEL}".` };
    }
    return { model: imageModels[0] };
  } catch (err) {
    return {
      model: DEFAULT_MODEL,
      warning: `Could not reach /models (${String(err)}); using fallback model "${DEFAULT_MODEL}".`,
    };
  }
}

/**
 * Call POST {baseUrl}/images/generations with an OpenAI-compatible payload and
 * return an MCP tool result (markdown text + structuredContent).
 */
export interface ImageGenerationArgs {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  quality?: string;
  style?: string;
  extra?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  model: string;
  created?: number;
  images: { index: number; url: string }[];
  warning?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Build a provider-specific image request while preserving the generic MCP args. */
export function buildImageGenerationBody(
  config: ServerConfig,
  args: ImageGenerationArgs,
  model: string,
): Record<string, unknown> {
  const isAgnes = isAgnesApiBaseUrl(config.baseUrl);
  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt,
    n: args.n ?? 1,
  };

  if (isAgnes) {
    // Agnes requires size and nests image/output format inside extra_body.
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
    // URL output is the default contract of this MCP. Explicit b64 settings are
    // still honored and will be normalized to a Storage URL afterwards.
    if (!("response_format" in extraBody) && extra.return_base64 !== true) {
      extraBody.response_format = "url";
    }

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

/** Execute image generation and always normalize image output to URLs. */
export async function executeImageGeneration(
  config: ServerConfig,
  args: ImageGenerationArgs,
): Promise<ImageGenerationResult> {
  const isAgnes = isAgnesApiBaseUrl(config.baseUrl);
  let model = args.model ?? config.defaultModel ?? (isAgnes ? AGNES_DEFAULT_IMAGE_MODEL : undefined);
  let modelNote: string | undefined;
  if (!model) {
    const picked = await pickModel(config.baseUrl, config.apiKey);
    model = picked.model;
    modelNote = picked.warning;
  }

  const body = buildImageGenerationBody(config, args, model);

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: normalizeProviderBaseUrl(config.baseUrl) });
  let data: { created?: number; data?: GeneratedImage[] };
  try {
    data = await client.images.generate(body as unknown as ImageGenerateParamsNonStreaming);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
    const detail = err instanceof Error ? err.message : String(err);
    const label = typeof status === "number" ? `Image API error (HTTP ${status})` : "Image API error";
    throw new Error(`${label}: ${detail}`);
  }

  const images = Array.isArray(data.data) ? data.data : [];
  const normalized: { index: number; url: string }[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i] ?? {};
    if (typeof img.url === "string" && img.url) {
      const dataUrl = parseBase64ImageDataUrl(img.url);
      if (dataUrl) {
        try {
          const url = await uploadBase64ImageToSupabase(dataUrl.base64, model, args, dataUrl.contentType);
          normalized.push({ index: i, url });
          continue;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`Image storage fallback failed: ${detail}`);
        }
      }
      normalized.push({ index: i, url: img.url });
      continue;
    }
    if (typeof img.b64_json === "string" && img.b64_json) {
      try {
        const url = await uploadBase64ImageToSupabase(img.b64_json, model, args);
        normalized.push({ index: i, url });
        continue;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Image storage fallback failed: ${detail}`);
      }
    }
    throw new Error(`Image API returned neither a URL nor base64 image data for model ${model}.`);
  }

  return { model, created: data.created, images: normalized, warning: modelNote };
}

async function generateImages(
  config: ServerConfig,
  args: ImageGenerationArgs,
): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean }> {
  try {
    const result = await executeImageGeneration(config, args);
    const lines: string[] = [];
    if (result.warning) lines.push(`> ${result.warning}`);
    lines.push(`Generated ${result.images.length} image(s) with model **${result.model}**.`);
    for (const image of result.images) lines.push(`Image ${image.index + 1}: ${image.url}`);
    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
      structuredContent: { model: result.model, created: result.created, images: result.images },
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

interface BuildServerOptions {
  asyncQueue?: boolean;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/** Builds a fresh McpServer instance per request (serverless-friendly). */
function buildServer(config: ServerConfig, options: BuildServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "generate_image",
    {
      description: options.asyncQueue
        ? "Queue an image-generation job and return a job_id immediately. Use get_image_job to poll until completed and retrieve image URLs."
        : "Generate one or more images through an OpenAI-compatible image generation API. Returns plain-text image URLs plus structured URL metadata. Base64 image content is never exposed.",
      inputSchema: z.object({
        prompt: z.string().describe("Detailed text description of the image(s) to generate."),
        model: z
          .string()
          .optional()
          .describe("Optional model override. When omitted, defaultModel from the endpoint query string is used; Agnes endpoints default to agnes-image-2.1-flash; otherwise the server auto-selects from GET /models."),
        size: z
          .string()
          .optional()
          .describe("Provider-specific image size, e.g. 1024x1024 or 1024x768. 'auto' lets compatible providers decide."),
        n: z.number().int().min(1).max(10).optional().describe("How many images to generate. Defaults to 1."),
        quality: z.enum(["standard", "hd"]).optional().describe("Quality, e.g. for DALL·E 3."),
        style: z.enum(["vivid", "natural"]).optional().describe("Style, e.g. for DALL·E 3."),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Any extra parameters to pass through to the provider, e.g. background or output_format."),
      }),
    },
    async (args) => {
      if (!config.apiKey) {
        return {
          content: [{
            type: "text",
            text: "No API key provided. Pass it via the `X-Api-Key` header, `Authorization: Bearer <key>`, or the `apiKey` query parameter. To use a registered indexed provider, also send `X-Provider: <N>`.",
          }],
          isError: true,
        };
      }
      if (!options.asyncQueue) return await generateImages(config, args);

      const admin = getSupabaseAdminConfig();
      if (!admin) {
        return {
          content: [{ type: "text", text: "Supabase Queue mode is not configured on this deployment." }],
          isError: true,
        };
      }

      const jobId = crypto.randomUUID();
      const requestSummary: Record<string, unknown> = {
        ...(args.model ? { model: args.model } : {}),
        ...(!args.model && config.defaultModel ? { default_model: config.defaultModel } : {}),
        ...(args.size ? { size: args.size } : {}),
        n: args.n ?? 1,
        ...(args.quality ? { quality: args.quality } : {}),
        ...(args.style ? { style: args.style } : {}),
      };
      try {
        await enqueueImageJob(jobId, requestSummary, {
          job_id: jobId,
          api_key: config.apiKey,
          base_url: config.baseUrl,
          ...(config.defaultModel ? { default_model: config.defaultModel } : {}),
          args,
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to queue image generation: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const kick = await kickImageWorker();
      const text = kick.ok
        ? `Image generation queued.\njob_id: ${jobId}\nstatus: queued\nCall get_image_job with this job_id to retrieve the result.`
        : `Image generation queued.\njob_id: ${jobId}\nstatus: queued\nworker kick warning: ${kick.detail ?? "unknown error"}\nCall get_image_job with this job_id to retry/kick processing and retrieve the result.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { job_id: jobId, status: "queued", worker_kicked: kick.ok },
      };
    },
  );

  if (options.asyncQueue) {
    server.registerTool(
      "get_image_job",
      {
        description: "Get the status and result URLs for a queued image generation job.",
        inputSchema: z.object({
          job_id: z.string().uuid().describe("Job id returned by generate_image."),
        }),
      },
      async (args) => {
        let job: ImageJobRow | null;
        try {
          job = await getImageJob(args.job_id);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to read image job: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
        if (!job) {
          return { content: [{ type: "text", text: `Image job not found: ${args.job_id}` }], isError: true };
        }
        if (job.status === "queued" || job.status === "processing") {
          await kickImageWorker();
        }
        const summary: Record<string, unknown> = {
          job_id: job.id,
          status: job.status,
          attempts: job.attempts,
          ...(job.result ? { result: job.result } : {}),
          ...(job.error ? { error: job.error } : {}),
        };
        const lines = [`job_id: ${job.id}`, `status: ${job.status}`];
        if (job.result?.images && Array.isArray(job.result.images)) {
          for (const [index, image] of job.result.images.entries()) {
            if (image && typeof image === "object" && "url" in image && typeof image.url === "string") {
              lines.push(`Image ${index + 1}: ${image.url}`);
            }
          }
        }
        if (job.error) lines.push(`error: ${job.error}`);
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: summary };
      },
    );
  }

  server.registerTool(
    "list_models",
    {
      description: "List all models from the configured OpenAI-compatible API (GET /models). Optionally filter model names by a keyword string; whitespace- or comma-separated terms are matched case-insensitively and all terms must be present.",
      inputSchema: z.object({
        keywords: z
          .string()
          .optional()
          .describe("Optional keywords used to filter model ids, e.g. 'gpt 5' or 'qwen,coder'."),
      }),
    },
    async (args) => {
      if (!config.apiKey) {
        return {
          content: [{
            type: "text",
            text: "No API key provided. Pass it via the `X-Api-Key` header, `Authorization: Bearer <key>`, or the `apiKey` query parameter. To use a registered indexed provider, also send `X-Provider: <N>`.",
          }],
          isError: true,
        };
      }
      const endpoint = `${config.baseUrl}/models`;
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Models API error (HTTP ${res.status}): ${await res.text()}` }],
          isError: true,
        };
      }
      const data = (await res.json()) as { data?: { id?: string }[] };
      const allModels = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
      const terms = (args.keywords ?? "")
        .toLowerCase()
        .split(/[\s,]+/)
        .map((term) => term.trim())
        .filter(Boolean);
      const models = terms.length
        ? allModels.filter((id) => {
          const lower = id.toLowerCase();
          return terms.every((term) => lower.includes(term));
        })
        : allModels;
      const suffix = terms.length ? ` matching "${args.keywords}"` : "";
      return {
        content: [{
          type: "text",
          text: models.length
            ? `Available models${suffix} (${models.length}):\n${models.join("\n")}`
            : `No models matched${suffix}.`,
        }],
        structuredContent: { models },
      };
    },
  );


  return server;
}

// The MCP HTTP handler. createMcpHandler serves the modern protocol revision and
// automatically falls back to the stateless 2025-era streamable HTTP flow, so
// current MCP clients (Claude Desktop, Cursor, Copilot, ...) work out of the box.
// (Named export is only used by the local test; the Val Town HTTP trigger uses
// the default export below.)
// The MCP HTTP handler. createMcpHandler serves the modern protocol revision and
// automatically falls back to the stateless 2025-era streamable HTTP flow, so
// current MCP clients (Claude Desktop, Cursor, Copilot, ...) work out of the box.
// The factory runs once per request and reads the API config from that request's
// headers / query params, so no environment variables are needed.
// (Named export is only used by the local tests; the Val Town HTTP trigger uses
// the default export below.)
export const mcpHandler = createMcpHandler((ctx) => {
  const config = extractConfig(ctx.requestInfo ?? new Request("http://localhost/"));
  return buildServer(config);
});

/** Supabase deployment variant: generate_image is queued and get_image_job is exposed. */
export const supabaseMcpHandler = createMcpHandler((ctx) => {
  const config = extractConfig(ctx.requestInfo ?? new Request("http://localhost/"));
  return buildServer(config, { asyncQueue: true });
});

// ---------------------------------------------------------------------------
// Val Town HTTP entry point
// ---------------------------------------------------------------------------

/** Val Town calls the default export directly with a web-standard Request. */
export default function handler(req: Request): Response | Promise<Response> {
  return mcpHandler.fetch(req);
}
