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
 * NO ENVIRONMENT VARIABLES REQUIRED — the OpenAI-compatible API base URL and
 * API key are supplied per request by the MCP client, via HTTP headers or URL
 * query parameters:
 *
 *   Headers:
 *     X-OpenAI-Api-Key: <api key>                  (required)
 *     X-OpenAI-Base-Url: https://api.openai.com/v1 (optional)
 *   Alternative for the key:  Authorization: Bearer <api key>
 *   Or as URL query params:   ?apiKey=...&baseUrl=...
 *
 *   The model is NOT configured by the client — it is auto-selected by calling
 *   GET {baseUrl}/models (preferring an image-capable model id). An optional
 *   `model` argument on generate_image can still override it per call.
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

// ---------------------------------------------------------------------------
// Per-request configuration (headers / query params)
// ---------------------------------------------------------------------------

interface ServerConfig {
  apiKey: string;
  baseUrl: string;
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

/** Extract base URL / API key from the request headers or query params. */
function extractConfig(req: Request): ServerConfig {
  const url = new URL(req.url);
  const headers = req.headers;

  let apiKey = headerOrParam(headers, "x-openai-api-key", url.searchParams, "apiKey");
  if (!apiKey) {
    const auth = headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) apiKey = auth.slice(7).trim();
  }

  const baseUrl = headerOrParam(headers, "x-openai-base-url", url.searchParams, "baseUrl", DEFAULT_BASE_URL);

  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
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
    return typeof keys.default === "string" ? keys.default.trim() : "";
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

async function uploadBase64ImageToSupabase(
  b64: string,
  model: string,
  args: { extra?: Record<string, unknown> },
): Promise<string> {
  const config = getSupabaseStorageConfig();
  if (!config) {
    throw new Error(
      "Supabase Storage fallback is not configured. SUPABASE_URL and a Supabase secret/service-role key are required when the provider only returns base64 image data.",
    );
  }

  const isPublic = await ensureStorageBucket(config);
  const { extension, contentType } = imageOutputFormat(args);
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
async function generateImages(
  config: ServerConfig,
  args: {
    prompt: string;
    model?: string;
    size?: string;
    n?: number;
    quality?: string;
    style?: string;
    extra?: Record<string, unknown>;
  },
): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean }> {
  // Model resolution is stateless: explicit arg, otherwise auto-select from /models for this call.
  let model = args.model;
  let modelNote: string | undefined;
  if (!model) {
    const picked = await pickModel(config.baseUrl, config.apiKey);
    model = picked.model;
    modelNote = picked.warning;
  }

  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt,
    n: args.n ?? 1,
  };
  // Request URL output where OpenAI-compatible providers support it. Official GPT Image models always return base64.
  if (!/^(?:gpt[-._]?image|chatgpt[-._]?image)/i.test(model)) body.response_format = "url";
  if (args.size && args.size !== "auto") body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.style) body.style = args.style;
  if (args.extra && typeof args.extra === "object") Object.assign(body, args.extra);

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  let data: { created?: number; data?: GeneratedImage[] };
  try {
    data = await client.images.generate(body as unknown as ImageGenerateParamsNonStreaming);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
    const detail = err instanceof Error ? err.message : String(err);
    const label = typeof status === "number" ? `Image API error (HTTP ${status})` : "Image API error";
    return {
      content: [{ type: "text", text: `${label}:\n${detail}` }],
      isError: true,
    };
  }

  const images = Array.isArray(data.data) ? data.data : [];

  const markdownLines: string[] = [];
  if (modelNote) markdownLines.push(`> ${modelNote}`);
  markdownLines.push(`Generated ${images.length} image(s) with model **${model}**.`);
  const structuredImages: Record<string, unknown>[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i] ?? {};
    const entry: Record<string, unknown> = { index: i };
    if (typeof img.url === "string" && img.url) {
      entry.url = img.url;
      markdownLines.push(`Image ${i + 1}: ${img.url}`);
    } else if (typeof img.b64_json === "string" && img.b64_json) {
      try {
        const url = await uploadBase64ImageToSupabase(img.b64_json, model, args);
        entry.url = url;
        markdownLines.push(`Image ${i + 1}: ${url}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Image storage fallback failed: ${detail}` }],
          isError: true,
        };
      }
    } else {
      return {
        content: [{
          type: "text",
          text: `Image API returned neither a URL nor base64 image data for model **${model}**.`,
        }],
        isError: true,
      };
    }
    structuredImages.push(entry);
  }

  return {
    content: [{ type: "text", text: markdownLines.join("\n\n") }],
    structuredContent: { model, created: data.created, images: structuredImages },
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/** Builds a fresh McpServer instance per request (serverless-friendly). */
function buildServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate one or more images through an OpenAI-compatible image generation API. Returns plain-text image URLs plus structured URL metadata. Base64 image content is never exposed. The API key and base URL come from request headers or apiKey/baseUrl query params.",
      inputSchema: z.object({
        prompt: z.string().describe("Detailed text description of the image(s) to generate."),
        model: z
          .string()
          .optional()
          .describe("Optional model override. When omitted, the server auto-selects a model from GET /models for this request."),
        size: z
          .enum(["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024", "auto"])
          .optional()
          .describe("Image size. 'auto' or omitting it lets the provider decide."),
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
            text: "No API key provided. Pass it via the `X-OpenAI-Api-Key` header, `Authorization: Bearer <key>`, or the `apiKey` query parameter.",
          }],
          isError: true,
        };
      }
      return await generateImages(config, args);
    },
  );

  server.registerTool(
    "list_image_models",
    {
      description: "List known image-generation models from the configured OpenAI-compatible API (GET /models), filtered by a curated regex of image-model families.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!config.apiKey) {
        return {
          content: [{
            type: "text",
            text: "No API key provided. Pass it via the `X-OpenAI-Api-Key` header, `Authorization: Bearer <key>`, or the `apiKey` query parameter.",
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
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && looksImageCapable(id));
      return {
        content: [{
          type: "text",
          text: models.length
            ? `Available image models (${models.length}):\n${models.join("\n")}`
            : "No known image-generation models matched the configured API's model list.",
        }],
        structuredContent: { models },
      };
    },
  );

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
            text: "No API key provided. Pass it via the `X-OpenAI-Api-Key` header, `Authorization: Bearer <key>`, or the `apiKey` query parameter.",
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

// ---------------------------------------------------------------------------
// Val Town HTTP entry point
// ---------------------------------------------------------------------------

/** Val Town calls the default export directly with a web-standard Request. */
export default function handler(req: Request): Response | Promise<Response> {
  return mcpHandler.fetch(req);
}
