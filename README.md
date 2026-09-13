# 🎨 imagen-mcp

MCP (Model Context Protocol) server for image generation via **OpenAI-compatible API**, written in **Deno** and can be **deployed to Val Town** in just seconds.

Connect to Claude Desktop, Cursor, GitHub Copilot, or any MCP client using **Streamable HTTP** transport.

> 🔑 **No environment variables are required for the upstream image API.** API key and base URL are sent by the MCP client with each request via **HTTP header** or **URL query param**. Supabase Storage environment variables are used only as a fallback when a provider returns base64 instead of a URL.

---

## 🔑 Passing Configuration (header / query param)

Each request to the MCP server can carry its own configuration:

| Information | Header | Query param | Required |
|---|---|---|---|
| API key | `X-OpenAI-Api-Key` | `apiKey` | ✅ |
| Base URL | `X-OpenAI-Base-Url` | `baseUrl` | ❌ (defaults to `https://api.openai.com/v1`) |

> 🤖 **Model does not need to be passed** — when `model` is omitted, the server calls `GET {baseUrl}/models` for that request and selects an image-generation model. Model selection and credentials are not persisted. Images are stored only when a provider returns base64 and a URL must be produced.

API key can also be passed via the standard header: `Authorization: Bearer <apiKey>`.

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
curl -X POST "https://<username>-<valname>.web.val.run/?apiKey=sk-...&baseUrl=https%3A%2F%2Fapi.openai.com%2Fv1" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## ✨ Features

- **`generate_image`** — uses the official OpenAI JavaScript/TypeScript SDK (`client.images.generate`) against the configured `baseUrl` (DALL·E 3, GPT Image models, and OpenAI-compatible providers)
  - Model **auto-selected per request** from `GET /models` (preferring image-generation models) when `model` is omitted; nothing is persisted
  - Supports `prompt`, `size`, `n`, `quality`, `style`
  - `extra` parameter to pass any additional fields to the provider
  - Returns plain-text image URLs + URL-only `structuredContent`; provider URLs are passed through directly, while base64-only results are uploaded to Supabase Storage and returned as Storage URLs
- **`list_image_models`** — lists only known image-generation models from `GET /models` using a curated regex
- **`list_models`** — lists all models from `GET /models`; optional `keywords` filters model ids case-insensitively using whitespace/comma-separated terms
- Upstream API credentials stay per-request. Supabase Storage fallback uses the deployment project's `SUPABASE_URL` and Supabase secret key (`SUPABASE_SECRET_KEYS` on current Edge Functions; legacy `SUPABASE_SERVICE_ROLE_KEY` is also supported)
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

## ☁️ Deploy to Supabase Edge Functions

A public Supabase Edge Function entrypoint is included at `supabase/functions/imagen-mcp/index.ts`. The function is configured with `verify_jwt = false`, so Supabase does not require a Supabase JWT before the MCP request reaches the server. The OpenAI-compatible credentials are still supplied per request through the existing `X-OpenAI-Api-Key` / `X-OpenAI-Base-Url` headers or `apiKey` / `baseUrl` query parameters.

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy imagen-mcp
```

After deployment, use:

```text
https://<your-project-ref>.supabase.co/functions/v1/imagen-mcp
```

Example query-param form:

```text
https://<your-project-ref>.supabase.co/functions/v1/imagen-mcp?apiKey=sk-...&baseUrl=https%3A%2F%2Fapi.openai.com%2Fv1
```

> `verify_jwt = false` makes the Edge Function itself public. Do not hard-code provider API keys in the function; send them per request as described above.

### CircleCI auto-deploy

The repository includes `.circleci/config.yml`. Pushes to `main` automatically deploy the `imagen-mcp` Edge Function through the pinned Supabase CLI using API-based bundling, so Docker is not required in CircleCI.

Configure these environment variables in the CircleCI project settings:

- `SUPABASE_ACCESS_TOKEN` — Supabase personal access token used by the CLI.
- `SUPABASE_PROJECT_REF` — the target Supabase project ref.

The deploy command keeps the function public with `--no-verify-jwt`, matching `supabase/config.toml`.

### Supabase Storage fallback

When an image provider returns `b64_json` instead of a URL, `generate_image` uploads the decoded image to Supabase Storage and returns the resulting URL. The default bucket is `imagen-mcp-generated`; it is created as a public bucket on first use. Set `SUPABASE_STORAGE_BUCKET` to override the bucket name.

On hosted Supabase Edge Functions, `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` are provided by the project automatically; the legacy `SUPABASE_SERVICE_ROLE_KEY` is also supported. Outside Supabase (for example Node.js or Val Town), set `SUPABASE_URL` plus either `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, or `SUPABASE_SECRET_KEYS` if you want base64-only providers to use the Storage fallback.

If an existing configured bucket is private, the server uploads there and returns a signed URL instead of forcing the bucket public.

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

> 💡 The server is URL-only and stateless. If a provider/model returns only base64 image data and no URL, `generate_image` returns an error instead of exposing or storing the image bytes.

---

## ⚠️ Notes

- **Val Town = serverless**: do not rely on module-scope state between requests. `createMcpHandler` uses a per-request factory, so it's safe.
- **API key via query param** may leak in logs/history; prefer using **headers**.
- **Image generation time** can be slow (10–60s) depending on the provider; some MCP clients may need increased HTTP timeout.

---

## 🧰 Technologies

- [OpenAI JavaScript/TypeScript SDK](https://github.com/openai/openai-node) — official client used for image generation
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `@modelcontextprotocol/server` (v2)
- [zod v4](https://zod.dev) — schema for tool
- [Val Town](https://val.town) — Deno serverless platform
