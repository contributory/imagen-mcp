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
 *   Or as URL query params:   ?api_key=...&base_url=...
 *
 *   The model is NOT configured by the client — it is auto-selected by calling
 *   GET {base_url}/models (preferring an image-capable model id). An optional
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "imagen-mcp";
const SERVER_VERSION = "2.2.0";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Last-resort fallback, only used if GET {base_url}/models cannot be reached.
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

  let apiKey = headerOrParam(headers, "x-openai-api-key", url.searchParams, "api_key");
  if (!apiKey) {
    const auth = headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) apiKey = auth.slice(7).trim();
  }

  const baseUrl = headerOrParam(headers, "x-openai-base-url", url.searchParams, "base_url", DEFAULT_BASE_URL);

  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible image generation
// ---------------------------------------------------------------------------

interface GeneratedImage {
  url?: string;
  b64_json?: string;
}

/** Persist a base64 image into Val Town scoped blob storage. Returns the key. */
async function saveImageToBlob(b64: string, model: string): Promise<string | null> {
  try {
    // This module only exists on Val Town; when unavailable the whole block is skipped.
    const { blob } = await import("https://esm.town/v/std/blob/main.ts");
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const key = `images/${model}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
    await blob.set(key, bytes);
    return key;
  } catch {
    return null; // blob storage only exists on Val Town
  }
}

// ---------------------------------------------------------------------------
// Model auto-selection via GET {base_url}/models
// ---------------------------------------------------------------------------

/** Substrings that hint a model id is image-capable. */
const IMAGE_MODEL_HINTS = [
  "gpt-image",
  "dall-e",
  "dall",
  "flux",
  "sdxl",
  "stable-diffusion",
  "stable",
  "imagen",
  "sana",
  "playground",
  "image",
];

/** Best-effort guess whether a model id is meant for image generation. */
function looksImageCapable(id: string): boolean {
  const lower = id.toLowerCase();
  return IMAGE_MODEL_HINTS.some((hint) => lower.includes(hint));
}

interface ModelPick {
  model: string;
  warning?: string;
}

/**
 * Pick a model by querying GET {base_url}/models. Prefers the first
 * image-capable id, otherwise the first model returned. Falls back to
 * DEFAULT_MODEL (with a warning) when /models cannot be reached.
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
    return { model: ids.find(looksImageCapable) ?? ids[0] };
  } catch (err) {
    return {
      model: DEFAULT_MODEL,
      warning: `Could not reach /models (${String(err)}); using fallback model "${DEFAULT_MODEL}".`,
    };
  }
}

// ---------------------------------------------------------------------------
// Last-used model memory
// ---------------------------------------------------------------------------

const LAST_MODEL_BLOB_KEY = "meta/last_models.json";
const lastModels = new Map<string, string>();
let blobLastModelsLoaded = false;

/** Return the remembered model for a base URL (in-memory, then Val Town blob). */
async function getRememberedModel(baseUrl: string): Promise<string | undefined> {
  if (!lastModels.has(baseUrl) && !blobLastModelsLoaded && Deno.env.get("valtown")) {
    try {
      const { blob } = await import("https://esm.town/v/std/blob/main.ts");
      const data = await blob.getJSON(LAST_MODEL_BLOB_KEY) as Record<string, unknown> | undefined;
      if (data && typeof data === "object") {
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "string") lastModels.set(key, value);
        }
      }
    } catch {
      // blob storage only exists on Val Town
    }
    blobLastModelsLoaded = true;
  }
  return lastModels.get(baseUrl);
}

/** Remember the model used for a base URL (in-memory + persist to Val Town blob). */
async function rememberModel(baseUrl: string, model: string): Promise<void> {
  lastModels.set(baseUrl, model);
  if (!Deno.env.get("valtown")) return;
  try {
    const { blob } = await import("https://esm.town/v/std/blob/main.ts");
    await blob.setJSON(LAST_MODEL_BLOB_KEY, Object.fromEntries(lastModels));
  } catch {
    // persistence failures are non-fatal
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
    response_format?: "url" | "b64_json";
    save_to_blob?: boolean;
    extra?: Record<string, unknown>;
  },
): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean }> {
  // Model resolution: explicit arg → remembered last-used model → auto-select from /models.
  // The resolved model is remembered per base URL so later calls don't need it again.
  let model = args.model;
  let modelNote: string | undefined;
  if (!model) {
    const remembered = await getRememberedModel(config.baseUrl);
    if (remembered) {
      model = remembered;
    } else {
      const picked = await pickModel(config.baseUrl, config.apiKey);
      model = picked.model;
      modelNote = picked.warning;
    }
  }
  if (lastModels.get(config.baseUrl) !== model) {
    await rememberModel(config.baseUrl, model);
  }

  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt,
    n: args.n ?? 1,
    response_format: args.save_to_blob ? "b64_json" : (args.response_format ?? "url"),
  };
  if (args.size && args.size !== "auto") body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.style) body.style = args.style;
  if (args.extra && typeof args.extra === "object") Object.assign(body, args.extra);

  const endpoint = `${config.baseUrl}/images/generations`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      content: [{ type: "text", text: `Network error while calling ${endpoint}: ${String(err)}` }],
      isError: true,
    };
  }

  if (!res.ok) {
    const detail = await res.text();
    return {
      content: [{ type: "text", text: `Image API error (HTTP ${res.status}):\n${detail}` }],
      isError: true,
    };
  }

  const data = (await res.json()) as { created?: number; data?: GeneratedImage[] };
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
      markdownLines.push(`![Generated image ${i + 1}](${img.url})`);
    } else if (typeof img.b64_json === "string" && img.b64_json) {
      entry.b64_json = img.b64_json;
      markdownLines.push(`![Generated image ${i + 1}](data:image/png;base64,${img.b64_json})`);
      if (args.save_to_blob) {
        const key = await saveImageToBlob(img.b64_json, model);
        if (key) {
          entry.blob_key = key;
          markdownLines.push(`Persisted to Val Town blob storage with key: \`${key}\``);
        }
      }
    } else {
      entry.raw = img;
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
        "Generate one or more images through an OpenAI-compatible image generation API (DALL·E 3, gpt-image-1, ...). Returns Markdown containing the images plus structured metadata (urls / base64). The API key and base URL come from the request headers (X-OpenAI-Api-Key, X-OpenAI-Base-Url) or query params (api_key, base_url).",
      inputSchema: z.object({
        prompt: z.string().describe("Detailed text description of the image(s) to generate."),
        model: z
          .string()
          .optional()
          .describe("Optional model override. When omitted, the last-used model for this base URL is reused, or auto-selected from GET /models on the first call."),
        size: z
          .enum(["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024", "auto"])
          .optional()
          .describe("Image size. 'auto' or omitting it lets the provider decide."),
        n: z.number().int().min(1).max(10).optional().describe("How many images to generate. Defaults to 1."),
        quality: z.enum(["standard", "hd"]).optional().describe("Quality, e.g. for DALL·E 3."),
        style: z.enum(["vivid", "natural"]).optional().describe("Style, e.g. for DALL·E 3."),
        response_format: z
          .enum(["url", "b64_json"])
          .optional()
          .describe("Return 'url' (default) for a shareable link, or 'b64_json' for inline base64 data."),
        save_to_blob: z
          .boolean()
          .optional()
          .describe("When true, forces b64_json and persists the image to Val Town blob storage (only on Val Town)."),
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
            text: "No API key provided. Pass it via the `X-OpenAI-Api-Key` header, `Authorization: Bearer <key>`, or the `api_key` query parameter.",
          }],
          isError: true,
        };
      }
      return await generateImages(config, args);
    },
  );

  server.registerTool(
    "list_models",
    {
      description: "List the models available from the configured OpenAI-compatible API (GET /models).",
      inputSchema: z.object({}),
    },
    async () => {
      if (!config.apiKey) {
        return {
          content: [{
            type: "text",
            text: "No API key provided. Pass it via the `X-OpenAI-Api-Key` header, `Authorization: Bearer <key>`, or the `api_key` query parameter.",
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
      const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
      return {
        content: [{
          type: "text",
          text: models.length ? `Available models (${models.length}):\n${models.join("\n")}` : "No models returned by the API.",
        }],
        structuredContent: { models },
      };
    },
  );

  server.registerTool(
    "list_images",
    {
      description:
        "List images that were previously generated with `save_to_blob: true` and persisted to this val's Val Town blob storage (images/<model>/...). Only works when deployed on Val Town.",
      inputSchema: z.object({
        model: z.string().optional().describe("Only list images for this model id, e.g. 'dall-e-3'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of images to return, newest first. Defaults to 20."),
      }),
    },
    async (args) => {
      // The 'valtown' secret is injected automatically by Val Town — no user configuration needed.
      if (!Deno.env.get("valtown")) {
        return {
          content: [{
            type: "text",
            text: "Blob storage is only available when deployed on Val Town. Images generated with `save_to_blob: true` are listed here.",
          }],
        };
      }
      try {
        const { blob } = await import("https://esm.town/v/std/blob/main.ts");
        const prefix = args.model ? `images/${args.model}/` : "images/";
        const listed = await blob.list(prefix);

        // Normalise the response shape: the API may return string[] or { keys: [...] }.
        let rawKeys: { key: string; size?: number; updatedAt?: string }[];
        if (Array.isArray(listed)) {
          rawKeys = listed.map((k) => (typeof k === "string" ? { key: k } : k));
        } else if (Array.isArray((listed as { keys?: unknown[] }).keys)) {
          rawKeys = (listed as { keys: { key: string; size?: number; updatedAt?: string }[] }).keys;
        } else {
          rawKeys = [];
        }

        const images = rawKeys
          .map((k) => ({
            key: k.key,
            ...(k.size !== undefined ? { size: k.size } : {}),
            ...(k.updatedAt ? { updatedAt: k.updatedAt } : {}),
          }))
          .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

        const shown = images.slice(0, args.limit ?? 20);
        const text = shown.length
          ? `Images in blob storage (showing ${shown.length} of ${images.length}):\n${shown.map((i) => `- ${i.key}`).join("\n")}`
          : "No images found in blob storage yet.";
        return {
          content: [{ type: "text", text }],
          structuredContent: { total: images.length, images: shown },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Cannot list images: ${String(err)}` }],
          isError: true,
        };
      }
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
