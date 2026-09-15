import {
  buildImageGenerationBody,
  isAgnesApiBaseUrl,
  normalizeProviderBaseUrl,
  type ImageGenerationArgs,
  type ServerConfig,
} from "../mcp-image-server.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const hosts = [
  "https://apihub.agnes-ai.com/v1",
  "https://apihub.agnes-ai.cn/v1",
  "https://api.agnes-ai.cn/v1",
];
for (const host of hosts) assert(isAgnesApiBaseUrl(host), `Agnes host not detected: ${host}`);
assert(!isAgnesApiBaseUrl("https://api.openai.com/v1"), "OpenAI host must not be detected as Agnes");
assert(
  normalizeProviderBaseUrl("https://apihub.agnes-ai.com") === "https://apihub.agnes-ai.com/v1",
  "Agnes host-only base URL should normalize to /v1",
);

const config: ServerConfig = { apiKey: "test", baseUrl: "https://apihub.agnes-ai.com/v1" };

const textArgs: ImageGenerationArgs = { prompt: "a lighthouse at night" };
const textBody = buildImageGenerationBody(config, textArgs, "agnes-image-2.1-flash");
assert(textBody.model === "agnes-image-2.1-flash", "wrong Agnes model");
assert(textBody.size === "1024x1024", "Agnes default size missing");
assert(!("response_format" in textBody), "Agnes response_format must never be top-level");
assert(
  (textBody.extra_body as Record<string, unknown>)?.response_format === "url",
  "Agnes URL response_format must be nested under extra_body",
);

const imageArgs: ImageGenerationArgs = {
  prompt: "turn it into watercolor",
  size: "1024x768",
  extra: {
    image: ["https://example.com/input.png"],
    response_format: "b64_json",
  },
};
const imageBody = buildImageGenerationBody(config, imageArgs, "agnes-image-2.1-flash");
const imageExtraBody = imageBody.extra_body as Record<string, unknown>;
assert(imageBody.size === "1024x768", "Agnes provider-specific size should pass through");
assert(!("image" in imageBody), "Agnes image input must not remain top-level");
assert(!("response_format" in imageBody), "Agnes response_format must not remain top-level");
assert(Array.isArray(imageExtraBody.image), "Agnes image input must be nested under extra_body.image");
assert(imageExtraBody.response_format === "b64_json", "Explicit Agnes response format must be preserved");

const nestedArgs: ImageGenerationArgs = {
  prompt: "compose",
  extra: {
    extra_body: {
      image: ["data:image/png;base64,abc"],
      response_format: "url",
      custom_flag: true,
    },
  },
};
const nestedBody = buildImageGenerationBody(config, nestedArgs, "agnes-image-2.1-flash");
const nestedExtra = nestedBody.extra_body as Record<string, unknown>;
assert(nestedExtra.custom_flag === true, "Existing Agnes extra_body fields should be preserved");
assert(nestedExtra.response_format === "url", "Existing Agnes response_format should be preserved");

console.log("Agnes adapter checks passed ✅");
