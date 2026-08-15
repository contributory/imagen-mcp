# 🎨 imagen-mcp

MCP (Model Context Protocol) server tạo ảnh qua **API tương thích OpenAI** (OpenAI-compatible), viết bằng **Deno** và có thể **deploy lên Val Town** chỉ trong vài giây.

Kết nối với Claude Desktop, Cursor, GitHub Copilot, hay bất kỳ MCP client nào bằng transport **Streamable HTTP**.

> 🚫 **Không cần cấu hình biến môi trường nào cả.** API key và base URL được MCP client gửi kèm theo từng request qua **HTTP header** hoặc **URL query param**.

---

## 🔑 Truyền cấu hình (header / query param)

Mỗi request tới MCP server đều có thể mang cấu hình riêng của nó:

| Thông tin | Header | Query param | Bắt buộc |
|---|---|---|---|
| API key | `X-OpenAI-Api-Key` | `api_key` | ✅ |
| Base URL | `X-OpenAI-Base-Url` | `base_url` | ❌ (mặc định `https://api.openai.com/v1`) |

> 🤖 **Model không cần truyền** — server **ghi nhớ model lần cuối** dùng cho từng base URL (bộ nhớ + blob storage trên Val Town). Lần đầu tự gọi `GET {base_url}/models` để chọn model (ưu tiên model tạo ảnh), các lần sau tái sử dụng model đã nhớ. Vẫn có thể ghi đè bằng tham số `model` của `generate_image`.

API key cũng có thể truyền qua header chuẩn: `Authorization: Bearer <api_key>`.

**Ví dụ với curl (qua header):**

```bash
curl -X POST https://<username>-<valname>.web.val.run/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-OpenAI-Api-Key: sk-...' \
  -H 'X-OpenAI-Base-Url: https://api.openai.com/v1' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Hoặc qua query param:**

```bash
curl -X POST "https://<username>-<valname>.web.val.run/?api_key=sk-...&base_url=https%3A%2F%2Fapi.openai.com%2Fv1" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## ✨ Tính năng

- **`generate_image`** — gọi `POST {base_url}/images/generations` (DALL·E 3, gpt-image-1, Groq, Together, OpenRouter, vLLM/LiteLLM local, ...)
  - Model **tự chọn & ghi nhớ** — lần đầu chọn từ `GET /models` (ưu tiên model tạo ảnh), sau đó nhớ lại model lần cuối cho từng base URL; không cần truyền `model`, vẫn có thể ghi đè
  - Hỗ trợ `prompt`, `size`, `n`, `quality`, `style`, `response_format`
  - Tham số `extra` để truyền thêm bất kỳ field nào cho provider
  - `save_to_blob: true` để lưu ảnh vào Val Town blob storage
  - Trả về Markdown kèm ảnh + `structuredContent` (url / base64) cho agent dùng lập trình
- **`list_models`** — liệt kê model khả dụng từ `GET /models`
- **`list_images`** — liệt kê những ảnh đã tạo và lưu vào blob storage (`images/<model>/...`) trên Val Town
- Không cần env vars — cấu hình theo từng request (multi-tenant, mỗi người dùng key của mình)
- Chạy serverless an toàn: mỗi request tạo một `McpServer` mới (per-request factory)

---

## 📁 Cấu trúc project

```
imagen-mcp/
├── mcp-image-server.ts      # File val chính — paste thẳng vào Val Town
├── deno.json                # Tasks: serve / test / test:mock / check
├── README.md
├── .gitignore
└── scripts/
    ├── serve-local.ts       # Chạy server HTTP local (test với MCP client thật)
    ├── test-local.ts        # Smoke test: initialize → tools/list → tools/call
    └── test-mock-api.ts     # E2E test: header / query param / Authorization
```

---

## 🚀 Deploy lên Val Town

### Cách 1 — Trình soạn thảo web (đơn giản nhất)

1. Vào [val.town](https://val.town) → **New val** → đặt tên (ví dụ `imagen-mcp`).
2. Dán toàn bộ nội dung `mcp-image-server.ts` vào editor.
3. Click **`+ Add trigger`** → chọn **HTTP**.
4. **Save** — val được deploy ngay lập tức. Endpoint của bạn:
   `https://<username>-<valname>.web.val.run`

> Không cần thêm bất kỳ environment variable nào — API key/base URL được gửi kèm từng request.

### Cách 2 — vt CLI

```bash
npx valtown val create --http <username>/imagen-mcp
# sau đó dán nội dung file mcp-image-server.ts và deploy
```

---

## 🔌 Kết nối MCP client

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

Thêm **MCP server** mới với:

- **Transport:** `Streamable HTTP`
- **URL:** `https://<username>-<valname>.web.val.run`
- **Headers:**
  - `X-OpenAI-Api-Key`: `<your-api-key>`
  - `X-OpenAI-Base-Url`: `https://api.openai.com/v1` (tùy chọn)

> Mỗi người dùng dùng API key của chính mình — server dùng chung được (multi-tenant), không có key nào nằm sẵn trên server.

---

## 🖥️ Chạy local (trước khi deploy)

Yêu cầu: [Deno](https://deno.land) ≥ 2.x.

```bash
# 1. Smoke test (không cần API key)
deno task test

# 2. E2E test với mock API (header / query param / Authorization)
deno task test:mock

# 3. Chạy server HTTP local
deno task serve
# → MCP server tại http://127.0.0.1:8789
# Gửi kèm header X-OpenAI-Api-Key khi gọi tools
```

Hoặc chạy trực tiếp:

```bash
deno run --allow-net --allow-env --allow-import scripts/serve-local.ts
```

---

## 🔧 Ví dụ sử dụng tool

```text
Vẽ một chú corgi phi hành gia trên mặt trăng, phong cách anime, nền sao lấp lánh.
```
→ gọi `generate_image({ prompt: "...", size: "1024x1024", quality: "hd" })`

Trả về:

```markdown
Generated 1 image(s) with model **dall-e-3**.

![Generated image 1](https://oaidalleapiprodscus.blob.core.windows.net/...)
```

---

## 🌐 Provider tương thích (OpenAI-compatible)

| Provider | `X-OpenAI-Base-Url` | Ghi chú |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | DALL·E 3, gpt-image-1 |
| Groq | `https://api.groq.com/openai/v1` | |
| Together AI | `https://api.together.xyz/v1` | |
| OpenRouter | `https://openrouter.ai/api/v1` | |
| vLLM / LiteLLM | `http://localhost:8000/v1` | chạy local |
| Ollama | `http://localhost:11434/v1` | (tùy model) |

> 💡 Một số provider/model chỉ trả `b64_json` (không hỗ trợ `url`). Khi đó hãy truyền `response_format: "b64_json"` — server sẽ trả ảnh dạng data URI; kèm `save_to_blob: true` để lưu vào blob storage của Val Town.

---

## ⚠️ Lưu ý

- **Val Town = serverless**: không dựa vào state ở module scope giữa các request. `createMcpHandler` dùng per-request factory nên an toàn.
- **Ảnh lưu trong blob storage** của Val Town (khi truyền `save_to_blob: true`) chỉ xem được qua blob admin trong sidebar, tool `list_images`, hoặc đọc bằng `blob.get()` — không phải URL public.
- **API key qua query param** có thể bị lộ trong log/lịch sử; ưu tiên dùng **header**.
- **Thời gian tạo ảnh** có thể lâu (10–60s) tùy provider; một số MCP client cần tăng timeout HTTP.

---

## 🧰 Công nghệ

- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `@modelcontextprotocol/server` (v2)
- [zod v4](https://zod.dev) — schema cho tool
- [Val Town](https://val.town) — nền tảng serverless chạy Deno
