# 🎨 imagen-mcp

MCP (Model Context Protocol) server for image generation via **OpenAI-compatible API**, written in **Deno** and can be **deployed to Val Town** in just seconds.

Connect to Claude Desktop, Cursor, GitHub Copilot, or any MCP client using **Streamable HTTP** transport.

> 🚫 **No environment variables required.** API key and base URL are sent by the MCP client with each request via **HTTP header** or **URL query param**.

---

## 🔑 Passing Configuration (header / query param)

Each request to the MCP server can carry its own configuration:

| Information | Header | Query param | Required |
|---|---|---|---|
| API key | `X-OpenAI-Api-Key` | `api_key` | ✅ |
| Base URL | `X-OpenAI-Base-Url` | `base_url` | ❌ (defaults to `https://api.openai.com/v1`) |

> 🤖 **Model does not need to be passed** — the server **remembers the last-used model** for each base URL (memory + blob storage on Val Town). On first use, it calls `GET {base_url}/models` to select a model (preferring image-generation models), and reuses the remembered model on subsequent calls. You can still override it using the `model` parameter of `generate_image`.

API key can also be passed via the standard header: `Authorization: Bearer <api_key>`.

**Example with curl (via header):**

```bash
curl -X POST https://<username>-<valname>.web.val.run/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-OpenAI-Api-Key: sk-...' \
  -H 'X-OpenAI-Base-Url: https://api.openai.com/v1' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Or via query param:**

```bash
curl -X POST "https://<username>-<valname>.web.val.run/?api_key=sk-...&base_url=https%3A%2F%2Fapi.openai.com%2Fv1" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## ✨ Features

- **`generate_image`** — calls `POST {base_url}/images/generations` (DALL·E 3, gpt-image-1, Groq, Together, OpenRouter, vLLM/LiteLLM local, ...)
  - Model **auto-selected & remembered** — first call selects from `GET /models` (preferring image-generation models), then remembers the last-used model for each base URL; no need to pass `model`, but you can still override it
  - Supports `prompt`, `size`, `n`, `quality`, `style`, `response_format`
  - `extra` parameter to pass any additional fields to the provider
  - `save_to_blob: true` to save images to Val Town blob storage
  - Returns Markdown with images + `structuredContent` (url / base64) for programmatic agent use
- **`list_models`** — lists available models from `GET /models`
- **`list_images`** — lists images previously generated and saved to blob storage (`images/<model>/...`) on Val Town
- No env vars required — configuration per request (multi-tenant, each user uses their own key)
- Runs safely serverless: each request creates a new `McpServer` instance (per-request factory)

---

## 📁 Project structure

```
imagen-mcp/
├── mcp-image-server.ts      # Main val file — paste directly into Val Town
├── deno.json                # Tasks: serve / test / test:mock / check
├── README.md
├── .gitignore
└── scripts/
    ├── serve-local.ts       # Run HTTP server locally (test with real MCP client)
    ├── test-local.ts        # Smoke test: initialize → tools/list → tools/call
    └── test-mock-api.ts     # E2E test: header / query param / Authorization
```

---

## 🚀 Deploy to Val Town

### Method 1 — Web editor (simplest)

1. Go to [val.town](https://val.town) → **New val** → name it (e.g., `imagen-mcp`).
2. Paste the entire content of `mcp-image-server.ts` into the editor.
3. Click **`+ Add trigger`** → select **HTTP**.
4. **Save** — the val is deployed immediately. Your endpoint:
   `https://<username>-<valname>.web.val.run`

> No environment variables needed — API key/base URL are sent with each request.

### Method 2 — vt CLI

```bash
npx valtown val create --http <username>/imagen-mcp
# then paste the content of mcp-image-server.ts and deploy
```

---

## 🔌 Connecting MCP clients

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imagen-mcp": {
      "type": "http",
      "url": "https://<username>-<valname>.web.val.run",
      "headers": {
        "X-OpenAI-Api-Key": "<your-api-key>",
        "X-OpenAI-Base-Url": "https://api.openai.com/v1"
      }
    }
  }
}
```

### Cursor / GitHub Copilot

Add a new **MCP server** with:

- **Transport:** `Streamable HTTP`
- **URL:** `https://<username>-<valname>.web.val.run`
- **Headers:**
  - `X-OpenAI-Api-Key`: `<your-api-key>`
  - `X-OpenAI-Base-Url`: `https://api.openai.com/v1` (optional)

> Each user uses their own API key — the server is shared (multi-tenant), no keys stored on the server.

---

## 🖥️ Running locally (before deployment)

Requirements: [Deno](https://deno.land) ≥ 2.x.

```bash
# 1. Smoke test (no API key needed)
deno task test

# 2. E2E test with mock API (header / query param / Authorization)
deno task test:mock

# 3. Run HTTP server locally
deno task serve
# → MCP server at http://127.0.0.1:8789
# Send X-OpenAI-Api-Key header when calling tools
```

Or run directly:

```bash
deno run --allow-net --allow-env --allow-import scripts/serve-local.ts
```

---

## 🔧 Tool usage examples

```text
Draw a corgi astronaut on the moon, anime style, with a sparkling starry background.
```
→ calls `generate_image({ prompt: "...", size: "1024x1024", quality: "hd" })`

Returns:

```markdown
Generated 1 image(s) with model **dall-e-3**.

![Generated image 1](https://oaidalleapiprodscus.blob.core.windows.net/...)
```

---

## 🌐 Compatible providers (OpenAI-compatible)

| Provider | `X-OpenAI-Base-Url` | Notes |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | DALL·E 3, gpt-image-1 |
| Groq | `https://api.groq.com/openai/v1` | |
| Together AI | `https://api.together.xyz/v1` | |
| OpenRouter | `https://openrouter.ai/api/v1` | |
| vLLM / LiteLLM | `http://localhost:8000/v1` | running locally |
| Ollama | `http://localhost:11434/v1` | (depends on model) |

> 💡 Some providers/models only return `b64_json` (no `url` support). In that case, pass `response_format: "b64_json"` — the server returns the image as a data URI; add `save_to_blob: true` to save to Val Town's blob storage.

---

## ⚠️ Notes

- **Val Town = serverless**: do not rely on module-scope state between requests. `createMcpHandler` uses a per-request factory, so it's safe.
- **Images stored in blob storage** on Val Town (when passing `save_to_blob: true`) can only be viewed via blob admin in the sidebar, the `list_images` tool, or by reading with `blob.get()` — they are not public URLs.
- **API key via query param** may leak in logs/history; prefer using **headers**.
- **Image generation time** can be slow (10–60s) depending on the provider; some MCP clients may need increased HTTP timeout.

---

## 🧰 Technologies

- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `@modelcontextprotocol/server` (v2)
- [zod v4](https://zod.dev) — schema for tool
- [Val Town](https://val.town) — Deno serverless platform
