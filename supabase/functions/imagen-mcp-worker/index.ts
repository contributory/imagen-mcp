import {
  executeImageGeneration,
  type ImageGenerationArgs,
  type ServerConfig,
} from "../../../main.ts";
import {
  deleteImageQueueMessage,
  getImageJob,
  isAuthorizedWorkerRequest,
  readImageQueue,
  updateImageJob,
} from "../../../supabase-queue.ts";

interface QueuePayload {
  job_id: string;
  api_key: string;
  base_url: string;
  default_model?: string;
  args: ImageGenerationArgs;
}

function isQueuePayload(value: unknown): value is QueuePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.job_id === "string" &&
    typeof v.api_key === "string" &&
    typeof v.base_url === "string" &&
    Boolean(v.args) && typeof v.args === "object" &&
    typeof (v.args as Record<string, unknown>).prompt === "string";
}

export async function processImageQueueOnce(): Promise<Record<string, unknown>> {
  const messages = await readImageQueue();
  const message = messages[0];
  if (!message) return { processed: 0, status: "empty" };

  const payload = message.message;
  if (!isQueuePayload(payload)) {
    await deleteImageQueueMessage(message.msg_id);
    return { processed: 0, status: "discarded_invalid_payload", msg_id: message.msg_id };
  }

  const existing = await getImageJob(payload.job_id);
  if (!existing) {
    await deleteImageQueueMessage(message.msg_id);
    return { processed: 0, status: "discarded_missing_job", job_id: payload.job_id };
  }
  if (existing.status === "completed" || existing.status === "failed") {
    await deleteImageQueueMessage(message.msg_id);
    return { processed: 0, status: "already_terminal", job_id: payload.job_id };
  }

  await updateImageJob(payload.job_id, {
    status: "processing",
    attempts: message.read_ct,
    error: null,
  });

  const config: ServerConfig = {
    apiKey: payload.api_key,
    baseUrl: payload.base_url.replace(/\/+$/, ""),
    ...(payload.default_model ? { defaultModel: payload.default_model } : {}),
  };

  try {
    const result = await executeImageGeneration(config, payload.args);
    const storedResult = {
      model: result.model,
      created: result.created,
      images: result.images,
      ...(result.warning ? { warning: result.warning } : {}),
    };
    await updateImageJob(payload.job_id, {
      status: "completed",
      result: storedResult,
      error: null,
      attempts: message.read_ct,
    });
    await deleteImageQueueMessage(message.msg_id);
    return {
      processed: 1,
      status: "completed",
      job_id: payload.job_id,
      images: result.images.length,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await updateImageJob(payload.job_id, {
      status: "failed",
      error: detail,
      attempts: message.read_ct,
    });
    await deleteImageQueueMessage(message.msg_id);
    return { processed: 1, status: "failed", job_id: payload.job_id, error: detail };
  }
}

function runInBackground(promise: Promise<unknown>): boolean {
  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (!runtime?.waitUntil) return false;
  runtime.waitUntil(promise);
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!isAuthorizedWorkerRequest(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const task = processImageQueueOnce().catch((err) => {
    console.error("[imagen-mcp-worker] background task failed:", err);
  });

  if (runInBackground(task)) {
    return Response.json({ accepted: true, background: true }, { status: 202 });
  }

  // Local Deno/test fallback where EdgeRuntime.waitUntil is unavailable.
  await task;
  return Response.json({ accepted: true, background: false }, { status: 200 });
});
