/**
 * MCP Image Generation Server — Node.js thuần (không Val Town / Deno)
 * Chạy:
 *   npm install
 *   node main.js              # HTTP http://127.0.0.1:3000/mcp
 *   node main.js --stdio      # STDIO cho Claude Desktop
 *   PORT=3000 OPENAI_API_KEY=sk-... node main.js
 */

import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile as writeFileFs } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---- config ----
const SERVER_NAME = "imagen-mcp";
const SERVER_VERSION = "2.2.0";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "dall-e-3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const LAST_MODELS_FILE = join(DATA_DIR, "last_models.json");

// ---- helpers ----
function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function extractConfig(req) {
  const host = getHeader(req, "host") || "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);

  let apiKey = getHeader(req, "x-openai-api-key") || url.searchParams.get("api_key") || "";
  if (!apiKey) {
    const auth = getHeader(req, "authorization");
    if (auth.startsWith("Bearer ")) apiKey = auth.slice(7).trim();
  }
  if (!apiKey) apiKey = process.env.OPENAI_API_KEY ?? process.env.X_OPENAI_API_KEY ?? "";

  let baseUrl = getHeader(req, "x-openai-base-url") || url.searchParams.get("base_url") || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;

  return { apiKey: String(apiKey).trim(), baseUrl: String(baseUrl).trim().replace(/\/+$/, "") };
}

// ---- model auto-select ----
const IMAGE_MODEL_HINTS = ["gpt-image","dall-e","dall","flux","sdxl","stable-diffusion","stable","imagen","sana","playground","image"];
function looksImageCapable(id) { const l = id.toLowerCase(); return IMAGE_MODEL_HINTS.some(h => l.includes(h)); }

async function pickModel(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return { model: DEFAULT_MODEL, warning: `Could not list models (HTTP ${res.status}); using fallback "${DEFAULT_MODEL}".` };
    const data = await res.json();
    const ids = (data.data ?? []).map(m => m.id).filter(id => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { model: DEFAULT_MODEL, warning: `No models returned; using fallback "${DEFAULT_MODEL}".` };
    return { model: ids.find(looksImageCapable) ?? ids[0] };
  } catch (err) {
    return { model: DEFAULT_MODEL, warning: `Could not reach /models (${String(err)}); using fallback "${DEFAULT_MODEL}".` };
  }
}

// ---- last model memory (file) ----
const lastModels = new Map();
let lastModelsLoaded = false;
async function loadLastModels() {
  if (lastModelsLoaded) return;
  lastModelsLoaded = true;
  try {
    const raw = await readFile(LAST_MODELS_FILE, "utf-8");
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") lastModels.set(k, v);
  } catch {}
}
async function getRememberedModel(baseUrl) { await loadLastModels(); return lastModels.get(baseUrl); }
async function rememberModel(baseUrl, model) {
  await loadLastModels();
  lastModels.set(baseUrl, model);
  try {
    await mkdir(dirname(LAST_MODELS_FILE), { recursive: true });
    await writeFileFs(LAST_MODELS_FILE, JSON.stringify(Object.fromEntries(lastModels), null, 2), "utf-8");
  } catch {}
}

// ---- save image ----
async function saveImageToFile(b64, model) {
  try {
    const dir = join(IMAGES_DIR, model);
    await mkdir(dir, { recursive: true });
    const filename = `${Date.now()}-${randomUUID().slice(0,8)}.png`;
    const filePath = join(dir, filename);
    await writeFileFs(filePath, Buffer.from(b64, "base64"));
    return `images/${model}/${filename}`;
  } catch { return null; }
}

// ---- core ----
async function generateImages(config, args) {
  let model = args.model;
  let modelNote;
  if (!model) {
    const remembered = await getRememberedModel(config.baseUrl);
    if (remembered) model = remembered;
    else { const picked = await pickModel(config.baseUrl, config.apiKey); model = picked.model; modelNote = picked.warning; }
  }
  if (lastModels.get(config.baseUrl) !== model) await rememberModel(config.baseUrl, model);

  const body = { model, prompt: args.prompt, n: args.n ?? 1, response_format: args.save_to_blob ? "b64_json" : (args.response_format ?? "url") };
  if (args.size && args.size !== "auto") body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.style) body.style = args.style;
  if (args.extra && typeof args.extra === "object") Object.assign(body, args.extra);

  const endpoint = `${config.baseUrl}/images/generations`;
  let res;
  try {
    res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body) });
  } catch (err) {
    return { content: [{ type: "text", text: `Network error while calling ${endpoint}: ${String(err)}` }], isError: true };
  }
  if (!res.ok) return { content: [{ type: "text", text: `Image API error (HTTP ${res.status}):\n${await res.text()}` }], isError: true };

  const data = await res.json();
  const images = Array.isArray(data.data) ? data.data : [];
  const markdownLines = [];
  if (modelNote) markdownLines.push(`> ${modelNote}`);
  markdownLines.push(`Generated ${images.length} image(s) with model **${model}**.`);
  const structuredImages = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i] ?? {};
    const entry = { index: i };
    if (typeof img.url === "string" && img.url) { entry.url = img.url; markdownLines.push(`![Generated image ${i+1}](${img.url})`); }
    else if (typeof img.b64_json === "string" && img.b64_json) {
      entry.b64_json = img.b64_json;
      markdownLines.push(`![Generated image ${i+1}](data:image/png;base64,${img.b64_json})`);
      if (args.save_to_blob) { const key = await saveImageToFile(img.b64_json, model); if (key) { entry.file = key; markdownLines.push(`Saved to \`${key}\``); } }
    } else entry.raw = img;
    structuredImages.push(entry);
  }
  return { content: [{ type: "text", text: markdownLines.join("\n\n") }], structuredContent: { model, created: data.created, images: structuredImages } };
}

// ---- MCP factory ----
function buildServer(config) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool("generate_image", {
    description: "Generate images via OpenAI-compatible API. Config via headers X-OpenAI-Api-Key / X-OpenAI-Base-Url, query ?api_key=&base_url=, or env OPENAI_API_KEY/OPENAI_BASE_URL.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed text description of the image(s) to generate."),
      model: z.string().optional().describe("Optional model override. Omit to auto-select/remember per baseUrl."),
      size: z.enum(["256x256","512x512","1024x1024","1024x1792","1792x1024","auto"]).optional(),
      n: z.number().int().min(1).max(10).optional(),
      quality: z.enum(["standard","hd"]).optional(),
      style: z.enum(["vivid","natural"]).optional(),
      response_format: z.enum(["url","b64_json"]).optional(),
      save_to_blob: z.boolean().optional().describe("When true, forces b64_json and saves to ./data/images/<model>/"),
      extra: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (args) => {
    if (!config.apiKey) return { content: [{ type: "text", text: "No API key. Pass X-OpenAI-Api-Key / Authorization: Bearer <key> / ?api_key=..., or set OPENAI_API_KEY." }], isError: true };
    return await generateImages(config, args);
  });

  server.registerTool("list_models", {
    description: "List models from GET {base_url}/models.",
    inputSchema: z.object({}),
  }, async () => {
    if (!config.apiKey) return { content: [{ type: "text", text: "No API key. Pass X-OpenAI-Api-Key / Authorization: Bearer <key> / ?api_key=..., or set OPENAI_API_KEY." }], isError: true };
    const res = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    if (!res.ok) return { content: [{ type: "text", text: `Models API error (HTTP ${res.status}): ${await res.text()}` }], isError: true };
    const data = await res.json();
    const models = (data.data ?? []).map(m => m.id).filter(Boolean);
    return { content: [{ type: "text", text: models.length ? `Available models (${models.length}):\n${models.join("\n")}` : "No models returned." }], structuredContent: { models } };
  });

  server.registerTool("list_images", {
    description: "List images previously saved with save_to_blob:true (stored in ./data/images/<model>/).",
    inputSchema: z.object({
      model: z.string().optional().describe("Filter by model, e.g. 'dall-e-3'."),
      limit: z.number().int().min(1).max(100).optional().describe("Max to return, newest first. Default 20."),
    }),
  }, async (args) => {
    const prefixDir = args.model ? join(IMAGES_DIR, args.model) : IMAGES_DIR;
    try { await mkdir(prefixDir, { recursive: true }); } catch {}
    let files = [];
    try {
      if (args.model) {
        const entries = await readdir(prefixDir).catch(() => []);
        for (const f of entries) {
          const full = join(prefixDir, f);
          try { const s = await stat(full); if (s.isFile()) files.push({ key: `images/${args.model}/${f}`, size: s.size, updatedAt: s.mtime.toISOString() }); } catch {}
        }
      } else {
        const models = await readdir(IMAGES_DIR).catch(() => []);
        for (const m of models) {
          const mDir = join(IMAGES_DIR, m);
          let entries = [];
          try { const s = await stat(mDir); if (!s.isDirectory()) continue; entries = await readdir(mDir); } catch { continue; }
          for (const f of entries) {
            const full = join(mDir, f);
            try { const s = await stat(full); if (s.isFile()) files.push({ key: `images/${m}/${f}`, size: s.size, updatedAt: s.mtime.toISOString() }); } catch {}
          }
        }
      }
    } catch (err) { return { content: [{ type: "text", text: `Cannot list images: ${String(err)}` }], isError: true }; }
    files.sort((a,b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    const shown = files.slice(0, args.limit ?? 20);
    const text = shown.length ? `Images in ./data (${shown.length}/${files.length}):\n${shown.map(i => `- ${i.key} (${i.size ?? "?"} bytes)`).join("\n")}` : "No images saved yet. Use generate_image with save_to_blob:true.";
    return { content: [{ type: "text", text }], structuredContent: { total: files.length, images: shown } };
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-OpenAI-Api-Key, X-OpenAI-Base-Url, mcp-session-id, mcp-protocol-version");
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
        res.end(SERVER_NAME + " v" + SERVER_VERSION + "\nMCP Streamable HTTP: POST http://" + host + ":" + port + "/mcp\nHealth: GET http://" + host + ":" + port + "/health\nPass API key via X-OpenAI-Api-Key / Authorization: Bearer <key> / ?api_key= or OPENAI_API_KEY env.\n");
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
    console.log(`  Pass key per-request: X-OpenAI-Api-Key / Authorization: Bearer <key> / ?api_key=`);
    console.log(`  Images saved to: ${IMAGES_DIR}`);
  });
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
  if (process.argv.includes("--stdio")) await startStdio();
  else startHttp();
}

export { buildServer, extractConfig, pickModel, SERVER_NAME, SERVER_VERSION };
