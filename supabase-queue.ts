export const IMAGE_QUEUE_NAME = "image_generation_jobs";
export const IMAGE_WORKER_FUNCTION = "imagen-mcp-worker";
export const DEFAULT_QUEUE_VISIBILITY_SECONDS = 450;

export interface SupabaseAdminConfig {
  url: string;
  serviceKey: string;
}

export interface ImageJobRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: "queued" | "processing" | "completed" | "failed";
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
}

export interface ImageQueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    job_id?: string;
    api_key?: string;
    base_url?: string;
    default_model?: string;
    args?: Record<string, unknown>;
  };
}

export function getSupabaseServiceKey(): string {
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
  } catch {
    // Ignore malformed platform-provided JSON and fall back to no config.
  }
  return "";
}

export function getSupabaseAdminConfig(): SupabaseAdminConfig | null {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const serviceKey = getSupabaseServiceKey();
  return url && serviceKey ? { url, serviceKey } : null;
}

export function supabaseAdminHeaders(serviceKey: string, contentType = "application/json"): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "Content-Type": contentType,
  };
}

async function rpc<T>(
  config: SupabaseAdminConfig,
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
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

export async function enqueueImageJob(params: {
  jobId: string;
  request: Record<string, unknown>;
  payload: Record<string, unknown>;
}): Promise<number> {
  const config = getSupabaseAdminConfig();
  if (!config) throw new Error("Supabase queue is not configured.");
  return await rpc<number>(config, "imagen_enqueue_image_job", {
    p_job_id: params.jobId,
    p_request: params.request,
    p_payload: params.payload,
  });
}

export async function getImageJob(jobId: string): Promise<ImageJobRow | null> {
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

export async function updateImageJob(
  jobId: string,
  patch: Partial<Pick<ImageJobRow, "status" | "result" | "error" | "attempts">>,
): Promise<void> {
  const config = getSupabaseAdminConfig();
  if (!config) throw new Error("Supabase queue is not configured.");
  const res = await fetch(`${config.url}/rest/v1/image_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: {
      ...supabaseAdminHeaders(config.serviceKey),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase image job update failed (HTTP ${res.status}): ${await res.text()}`);
}

export async function readImageQueue(
  visibilitySeconds = DEFAULT_QUEUE_VISIBILITY_SECONDS,
  quantity = 1,
): Promise<ImageQueueMessage[]> {
  const config = getSupabaseAdminConfig();
  if (!config) throw new Error("Supabase queue is not configured.");
  return await rpc<ImageQueueMessage[]>(config, "imagen_read_image_jobs", {
    p_vt: visibilitySeconds,
    p_qty: quantity,
  });
}

export async function deleteImageQueueMessage(messageId: number): Promise<boolean> {
  const config = getSupabaseAdminConfig();
  if (!config) throw new Error("Supabase queue is not configured.");
  return await rpc<boolean>(config, "imagen_delete_image_job_message", { p_msg_id: messageId });
}

export async function kickImageWorker(): Promise<{ ok: boolean; detail?: string }> {
  const config = getSupabaseAdminConfig();
  if (!config) return { ok: false, detail: "Supabase queue is not configured." };

  try {
    const res = await fetch(`${config.url}/functions/v1/${IMAGE_WORKER_FUNCTION}`, {
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

export function isAuthorizedWorkerRequest(req: Request): boolean {
  const config = getSupabaseAdminConfig();
  if (!config) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${config.serviceKey}`;
}
