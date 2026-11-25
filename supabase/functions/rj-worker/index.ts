import { createClient } from "npm:@supabase/supabase-js@2";
import {
  classifyProviderFailure,
  cooldownUntil,
  selectEligibleProviders,
  type ProviderHealth,
} from "../_shared/provider-registry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Prefer the modern secret key; omit Authorization because secret keys belong in apikey only.
 // Fall back to the legacy JWT service-role key while Supabase's transition period remains active.
const secretMapRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
const secretKey = secretMapRaw
  ? (JSON.parse(secretMapRaw) as Record<string, string>)["default"]
  : "";
const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_KEY = secretKey || legacyServiceRoleKey;

if (!SUPABASE_URL || !ADMIN_KEY) {
  throw new Error("RJ worker is missing its server-side Supabase credentials");
}

const admin = createClient(SUPABASE_URL, ADMIN_KEY, {
  global: { headers: secretKey ? { Authorization: "" } : {} },
  auth: { persistSession: false, autoRefreshToken: false },
});

type QueueMessage = {
  msg_id: number | string;
  message: { job_id?: string; user_id?: string };
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function buildPrompt(topic: string, language: string) {
  return `Create an original, age-appropriate children's story for a YouTube video.
Topic: ${topic}
Language: ${language}
Requirements:
- Write in natural ${language}; keep names and sentences easy for children.
- Aim for a 4–6 minute narration.
- Start with an engaging title and a short hook.
- Divide the story into 6–8 clearly numbered scenes.
- For every scene provide: visual description, narrator voice-over, and any short dialogue.
- Finish with a gentle positive moral and a short closing line.
- Keep it kind, safe, non-frightening, and suitable for children.
- Do not use copyrighted characters, existing story plots, or song lyrics.
Return only the complete story script as readable text.`;
}

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: "gemini-3.5-flash-lite",
        input: prompt,
        store: false,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error?.message ?? body?.message ?? "Gemini request failed";
      throw Object.assign(new Error(String(detail)), { status: res.status });
    }
    const stepText = Array.isArray(body?.steps)
      ? body.steps
          .filter((step: { type?: string }) => step.type === "model_output")
          .flatMap((step: { content?: { type?: string; text?: string }[] }) => step.content ?? [])
          .filter((part: { type?: string }) => part.type === "text")
          .map((part: { text?: string }) => part.text ?? "")
          .join("\\n")
      : "";
    const text = String(body?.output_text ?? stepText).trim();
    if (!text) throw Object.assign(new Error("Gemini returned an empty story"), { status: 502 });
    return text;
  } finally {
    clearTimeout(timer);
  }
}
async function callOpenRouterFree(apiKey: string, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Uchihashan/RJ",
        "X-Title": "RJ",
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          { role: "system", content: "You write original, safe, age-appropriate children's stories." },
          { role: "user", content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 5000,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error?.message ?? "OpenRouter free-model request failed";
      throw Object.assign(new Error(String(detail)), { status: res.status });
    }
    const text = body?.choices?.[0]?.message?.content?.trim();
    if (!text) throw Object.assign(new Error("OpenRouter returned an empty story"), { status: 502 });
    return text;
  } finally {
    clearTimeout(timer);
  }
}


const PIPELINE_STAGES = [
  ["brief", 1, null],
  ["script_storyboard", 2, "text"],
  ["scene_assets", 3, "image_or_video"],
  ["voice_audio", 4, "speech"],
  ["captions", 5, "transcription_or_tts_alignment"],
  ["timeline_edit", 6, "media_assembly"],
  ["render_export", 7, "render"],
  ["quality_check", 8, "media_analysis"],
  ["metadata_thumbnail", 9, "text_and_image"],
  ["youtube_upload", 10, "youtube_upload"],
  ["youtube_schedule_verify", 11, "youtube_schedule"],
] as const;

async function initializePipelineStages(jobId: string, userId: string) {
  const rows = PIPELINE_STAGES.map(([stage_key, stage_order, required_capability]) => ({
    job_id: jobId,
    user_id: userId,
    stage_key,
    stage_order,
    required_capability,
    idempotency_key: jobId + ":" + stage_key,
    status: stage_key === "brief" ? "succeeded" : "pending",
    ...(stage_key === "brief" ? { started_at: new Date().toISOString(), finished_at: new Date().toISOString() } : {}),
  }));
  const { error } = await admin.from("job_stages").upsert(rows, {
    onConflict: "job_id,stage_key",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

async function markPipelineBlocked(jobId: string, stageKey: string, reason: string) {
  const { error } = await admin.from("job_stages").update({
    status: "blocked",
    locked_at: null,
    error_code: "capability_provider_missing",
    error_message: reason.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq("job_id", jobId).eq("stage_key", stageKey);
  if (error) throw error;
}

async function claimPipelineStage(jobId: string, userId: string, stageKey: string) {
  const { data, error } = await admin.rpc("rj_claim_job_stage", {
    p_job_id: jobId,
    p_user_id: userId,
    p_stage_key: stageKey,
    p_lease_seconds: 600,
  });
  if (error) throw error;
  return data === true;
}

async function processJob(message: QueueMessage) {
  const payload = message.message ?? {};
  const jobId = payload.job_id;
  const userId = payload.user_id;

  if (!jobId || !userId) {
    await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
    return { outcome: "discarded_invalid_message" };
  }

  const { data: job, error: loadError } = await admin
    .from("jobs")
    .select("id,user_id,job_type,status,input,attempt_count")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();

  if (loadError) throw loadError;
  if (!job || job.job_type !== "video_generation" || !["queued", "waiting_retry"].includes(job.status)) {
    await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
    return { job_id: jobId, outcome: "discarded_stale_message" };
  }

  await initializePipelineStages(jobId, userId);

  // The pgmq visibility window and cron overlap can expose the same job to
  // concurrent workers. Claim the stage atomically before any provider call.
  const stageClaimed = await claimPipelineStage(jobId, userId, "script_storyboard");
  if (!stageClaimed) {
    await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
    return { job_id: jobId, outcome: "stage_already_claimed_or_finished" };
  }

  const { data: credentialRows, error: credentialError } = await admin.rpc("rj_get_provider_keys", { p_user_id: userId });
  if (credentialError) throw credentialError;
  const credentialMap = new Map<string, string>(
    (credentialRows ?? []).map((row: { provider: string; api_key: string }) => [row.provider, row.api_key]),
  );
  const { data: policyRow, error: policyError } = await admin.from("provider_user_policies")
    .select("allow_paid_providers,monthly_budget_usd")
    .eq("user_id", userId)
    .maybeSingle();
  if (policyError) throw policyError;
  const policy = {
    allowPaidProviders: policyRow?.allow_paid_providers === true,
    monthlyBudgetUsd: Number(policyRow?.monthly_budget_usd ?? 0),
  };
  const { data: healthRows, error: healthError } = await admin.from("provider_health")
    .select("provider_key,state,cooldown_until")
    .eq("user_id", userId)
    .eq("capability", "text");
  if (healthError) throw healthError;
  const eligible = selectEligibleProviders("text", credentialMap, (healthRows ?? []) as ProviderHealth[], policy);
  const prompt = buildPrompt(String(job.input?.topic ?? ""), String(job.input?.language ?? "Tamil"));
  const providers = eligible.map((spec) => ({
    ...spec,
    run: () => spec.key === "gemini"
      ? callGemini(credentialMap.get("gemini")!, prompt)
      : callOpenRouterFree(credentialMap.get("openrouter")!, prompt),
  }));

  if (providers.length === 0) {
    const compatibleProviders = selectEligibleProviders("text", credentialMap, [], policy);
    const cooling = (healthRows ?? []).filter((row: ProviderHealth) =>
      compatibleProviders.some((provider) => provider.key === row.provider_key)
      && row.state === "cooldown" && row.cooldown_until
      && new Date(row.cooldown_until).getTime() > Date.now()
    );
    if (cooling.length) {
      const retryAt = cooling.map((row: ProviderHealth) => row.cooldown_until as string)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
      const delaySeconds = Math.max(60, Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1000));
      const { error: retryUpdateError } = await admin.from("jobs").update({
        status: "waiting_retry", current_stage: "script_storyboard",
        error_code: "text_providers_cooling_down",
        error_message: "Compatible text providers are cooling down. RJ will retry automatically.",
        run_after: retryAt, updated_at: new Date().toISOString(),
      }).eq("id", jobId).eq("user_id", userId);
      if (retryUpdateError) throw retryUpdateError;
      const { error: stageRetryError } = await admin.from("job_stages").update({
        status: "waiting_retry", locked_at: null, error_code: "provider_cooldown",
        error_message: "All compatible text providers are cooling down.", updated_at: new Date().toISOString(),
      }).eq("job_id", jobId).eq("stage_key", "script_storyboard");
      if (stageRetryError) throw stageRetryError;
      const { error: enqueueError } = await admin.rpc("rj_retry_job", { p_message: payload, p_delay_seconds: delaySeconds });
      if (enqueueError) throw enqueueError;
      const { error: archiveError } = await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
      if (archiveError) throw archiveError;
      return { job_id: jobId, outcome: "waiting_for_provider_cooldown", delay_seconds: delaySeconds };
    }

    const hasKeys = credentialMap.size > 0;
    const paidConsentNeeded = hasKeys && !policy.allowPaidProviders && !credentialMap.has("openrouter");
    const pauseCode = paidConsentNeeded ? "paid_provider_consent_required" : "provider_not_configured";
    const pauseMessage = paidConsentNeeded
      ? "Only account-billed providers are connected. RJ will not use them until paid-provider metering and explicit spending controls are enabled."
      : "Connect a compatible free text provider in RJ Settings. Paid providers remain disabled by default.";
    const { error: pauseError } = await admin.from("jobs").update({
      status: "paused",
      current_stage: "script_storyboard",
      error_code: pauseCode,
      error_message: pauseMessage,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("user_id", userId);
    if (pauseError) throw pauseError;
    await markPipelineBlocked(jobId, "script_storyboard", pauseMessage);
    const { error: archiveError } = await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
    if (archiveError) throw archiveError;
    return { job_id: jobId, outcome: paidConsentNeeded ? "paused_paid_consent_required" : "paused_provider_not_configured" };
  }


  const failures: ReturnType<typeof classifyProviderFailure>[] = [];
  for (const provider of providers) {
    const stageStartedAt = new Date().toISOString();
    const { error: stageStartError } = await admin.from("job_stages").update({
      status: "running", selected_provider: provider.label, started_at: stageStartedAt,
      error_code: null, error_message: null, updated_at: stageStartedAt,
    }).eq("job_id", jobId).eq("stage_key", "script_storyboard");
    if (stageStartError) throw stageStartError;
    const { data: attempt, error: attemptError } = await admin
      .from("job_attempts")
      .insert({ job_id: jobId, provider: provider.label, status: "started" })
      .select("id")
      .single();
    if (attemptError) throw attemptError;
    const { data: providerAttempt, error: providerAttemptError } = await admin
      .from("provider_attempts")
      .insert({
        user_id: userId,
        job_id: jobId,
        stage_key: "script_storyboard",
        capability: "text",
        provider_key: provider.key,
        model_key: provider.model,
        attempt_number: failures.length + 1,
        status: "started",
      })
      .select("id")
      .single();
    if (providerAttemptError) throw providerAttemptError;

    let story: string;
    try {
      story = await provider.run();
    } catch (error) {
      const failure = classifyProviderFailure(error);
      failures.push(failure);
      const cooldown = cooldownUntil(failure, failures.length);
      const { error: healthUpdateError } = await admin.from("provider_health").upsert({
        user_id: userId, provider_key: provider.key, capability: "text",
        state: cooldown ? "cooldown" : "needs_attention",
        cooldown_until: cooldown,
        last_http_status: failure.status,
        last_error_code: failure.code,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,provider_key,capability" });
      if (healthUpdateError) throw healthUpdateError;
      const { error: failureUpdateError } = await admin.from("job_attempts").update({
        status: failure.quota ? "quota_exhausted" : failure.status === 429 ? "rate_limited" : "failed",
        error_code: failure.code,
        safe_error_message: failure.message,
        finished_at: new Date().toISOString(),
      }).eq("id", attempt.id);
      if (failureUpdateError) throw failureUpdateError;
      const { error: providerAttemptUpdateError } = await admin.from("provider_attempts").update({
        status: failure.quota ? "quota_exhausted" : failure.status === 429 ? "rate_limited" : failure.retryable ? "failed" : "needs_attention",
        http_status: failure.status,
        error_code: failure.code,
        safe_error_message: failure.message,
        finished_at: new Date().toISOString(),
      }).eq("id", providerAttempt.id);
      if (providerAttemptUpdateError) throw providerAttemptUpdateError;
      continue;
    }

    const { error: healthUpdateError } = await admin.from("provider_health").upsert({
      user_id: userId, provider_key: provider.key, capability: "text",
      state: "available", cooldown_until: null, last_http_status: 200,
      last_error_code: null, updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,provider_key,capability" });
    if (healthUpdateError) throw healthUpdateError;

    const { error: attemptUpdateError } = await admin.from("job_attempts").update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
    }).eq("id", attempt.id);
    if (attemptUpdateError) throw attemptUpdateError;
    const { error: providerAttemptSuccessError } = await admin.from("provider_attempts").update({
      status: "succeeded",
      http_status: 200,
      finished_at: new Date().toISOString(),
    }).eq("id", providerAttempt.id);
    if (providerAttemptSuccessError) throw providerAttemptSuccessError;

    const { error: jobUpdateError } = await admin.from("jobs").update({
      status: "blocked",
      current_stage: "scene_assets",
      input: { ...job.input, stage: "story_ready" },
      output: {
        stage: "story_ready",
        story,
        provider: provider.label,
        generated_at: new Date().toISOString(),
      },
      error_code: null,
      error_message: null,
      attempt_count: Number(job.attempt_count ?? 0) + failures.length + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("user_id", userId);
    if (jobUpdateError) throw jobUpdateError;

    const now = new Date().toISOString();
    const { error: storyStageError } = await admin.from("job_stages").update({
      status: "succeeded",
      locked_at: null,
      selected_provider: provider.label,
      output: { story_ready: true },
      finished_at: now,
      updated_at: now,
    }).eq("job_id", jobId).eq("stage_key", "script_storyboard");
    if (storyStageError) throw storyStageError;
    const { error: sceneQueueError } = await admin.from("job_stages").update({
      status: "pending",
      locked_at: null,
      error_code: null,
      error_message: null,
      run_after: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("job_id", jobId).eq("stage_key", "scene_assets");
    if (sceneQueueError) throw sceneQueueError;

    const { error: archiveError } = await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
    if (archiveError) throw archiveError;
    return { job_id: jobId, outcome: "story_ready", provider: provider.label };
  }

  // Retry if at least one configured provider failed transiently; a different provider may have a bad key.
  const retryable = failures.some((failure) => failure.retryable);
  const delaySeconds = failures.some((failure) => failure.quota) ? 1800 : 300;
  if (retryable) {
    const runAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const { error: retryUpdateError } = await admin.from("jobs").update({
      status: "waiting_retry",
      error_code: failures.some((failure) => failure.quota) ? "provider_quota_exhausted" : "provider_temporarily_unavailable",
      error_message: "All configured providers are temporarily unavailable. RJ will retry automatically.",
      run_after: runAfter,
      attempt_count: Number(job.attempt_count ?? 0) + failures.length,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("user_id", userId);
    if (retryUpdateError) throw retryUpdateError;
    const { error: stageRetryError } = await admin.from("job_stages").update({
      status: "waiting_retry", locked_at: null, error_code: "provider_temporarily_unavailable",
      error_message: "All attempted text providers are temporarily unavailable.", updated_at: new Date().toISOString(),
    }).eq("job_id", jobId).eq("stage_key", "script_storyboard");
    if (stageRetryError) throw stageRetryError;
    const { error: enqueueError } = await admin.rpc("rj_retry_job", {
      p_message: payload,
      p_delay_seconds: delaySeconds,
    });
    if (enqueueError) throw enqueueError;
    const { error: archiveError } = await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
    if (archiveError) throw archiveError;
    return { job_id: jobId, outcome: "waiting_retry", delay_seconds: delaySeconds };
  }

  const { error: failedUpdateError } = await admin.from("jobs").update({
    status: "failed",
    error_code: "all_providers_failed",
    error_message: failures.map((failure) => failure.code + ": " + failure.message).join(" | ").slice(0, 1000),
    attempt_count: Number(job.attempt_count ?? 0) + failures.length,
    updated_at: new Date().toISOString(),
  }).eq("id", jobId).eq("user_id", userId);
  if (failedUpdateError) throw failedUpdateError;
  const { error: stageFailedError } = await admin.from("job_stages").update({
    status: "failed", locked_at: null, error_code: "all_providers_failed",
    error_message: failures.map((failure) => failure.message).join(" | ").slice(0, 500),
    finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("job_id", jobId).eq("stage_key", "script_storyboard");
  if (stageFailedError) throw stageFailedError;
  const { error: archiveError } = await admin.rpc("rj_archive_job", { p_msg_id: Number(message.msg_id) });
  if (archiveError) throw archiveError;
  return { job_id: jobId, outcome: "failed", providers_tried: failures.map((failure) => failure.code) };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const token = req.headers.get("x-rj-worker-token") ?? "";
  const { data: authorized, error: authError } = await admin.rpc("rj_validate_worker_token", { p_token: token });
  if (authError || authorized !== true) return response({ error: "Unauthorized" }, 401);

  let resumed = 0;
  const { data: resumedCount, error: resumeError } = await admin.rpc("rj_requeue_paused_jobs", { p_limit: 5 });
  if (resumeError) {
    console.error("RJ paused-job resume failed", resumeError.message);
  } else {
    resumed = Number(resumedCount ?? 0);
  }

  const { data: messages, error } = await admin.rpc("rj_read_jobs", { p_qty: 2 });
  if (error) {
    console.error("RJ queue read failed", error.message);
    return response({ error: "Queue read failed" }, 500);
  }

  const results = [];
  for (const message of (messages ?? []) as QueueMessage[]) {
    try {
      results.push(await processJob(message));
    } catch (error) {
      console.error("RJ job processing failed", error);
      results.push({ msg_id: String(message.msg_id), outcome: "processing_error" });
      // Do not archive on unexpected errors. PGMQ visibility timeout makes the job available again.
    }
  }

  return response({ ok: true, resumed, processed: results.length, results });
});
