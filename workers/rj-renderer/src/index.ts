import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  buildKenBurnsFilter,
  buildSceneOverlaySvg,
  buildSceneSvg,
  buildSrt,
  sceneDurationSeconds,
  splitStoryIntoScenes,
} from "./pipeline.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.RJ_RENDER_BUCKET ?? "rj-renders";
const POLL_MS = Math.max(5_000, Number(process.env.RJ_RENDER_POLL_MS ?? 15_000));
const BATCH_SIZE = Math.max(1, Math.min(5, Number(process.env.RJ_RENDER_BATCH_SIZE ?? 2)));

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error("Renderer requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type StageRow = {
  job_id: string;
  user_id: string;
  stage_key: string;
  attempt_count: number;
};

type JobRow = {
  id: string;
  user_id: string;
  status: string;
  current_stage: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
};

let stopping = false;
let activeJob = false;

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ service: "rj-renderer", event, at: new Date().toISOString(), ...details }));
}

async function runCommand(command: string, args: string[], cwd: string, stdinText?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    if (stdinText !== undefined) child.stdin.end(stdinText);
    else child.stdin.end();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10 * 60_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-20_000); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-20_000); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

async function updateStage(
  db: SupabaseClient,
  jobId: string,
  stageKey: string,
  values: Record<string, unknown>,
) {
  const { error } = await db.from("job_stages").update({
    ...values,
    locked_at: null,
    updated_at: new Date().toISOString(),
  }).eq("job_id", jobId).eq("stage_key", stageKey);
  if (error) throw error;
}

async function claimStage(db: SupabaseClient, stage: StageRow): Promise<boolean> {
  const { data, error } = await db.rpc("rj_claim_job_stage", {
    p_job_id: stage.job_id,
    p_user_id: stage.user_id,
    p_stage_key: stage.stage_key,
    p_lease_seconds: 1800,
  });
  if (error) throw error;
  return data === true;
}

async function loadReadyStages(db: SupabaseClient): Promise<StageRow[]> {
  const { data, error } = await db.from("job_stages")
    .select("job_id,user_id,stage_key,attempt_count")
    .in("stage_key", ["scene_assets", "youtube_upload"])
    .in("status", ["pending", "queued", "waiting_retry", "blocked"])
    .lte("run_after", new Date().toISOString())
    .order("run_after", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;
  return (data ?? []) as StageRow[];
}

async function loadJob(db: SupabaseClient, stage: StageRow): Promise<JobRow | null> {
  const { data, error } = await db.from("jobs")
    .select("id,user_id,status,current_stage,input,output")
    .eq("id", stage.job_id)
    .eq("user_id", stage.user_id)
    .maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

async function storyStageIsReady(db: SupabaseClient, jobId: string): Promise<boolean> {
  const { data, error } = await db.from("job_stages")
    .select("status")
    .eq("job_id", jobId)
    .eq("stage_key", "script_storyboard")
    .maybeSingle();
  if (error) throw error;
  return data?.status === "succeeded";
}

async function loadCloudflareCredential(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.rpc("rj_get_provider_keys", { p_user_id: userId });
  if (error) throw error;
  const row = (data ?? []).find((item: { provider: string; api_key: string }) => item.provider === "cloudflare");
  return typeof row?.api_key === "string" ? row.api_key : null;
}

async function cloudflareImageCoolingDown(db: SupabaseClient, userId: string): Promise<boolean> {
  const now = Date.now();
  const { data: daily, error: dailyError } = await db.from("provider_attempts")
    .select("id")
    .eq("user_id", userId)
    .eq("provider_key", "cloudflare_flux_schnell")
    .eq("error_code", "daily_free_quota_exhausted")
    .gte("created_at", new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())).toISOString())
    .limit(1);
  if (dailyError) throw dailyError;
  if ((daily ?? []).length) return true;
  const { data: limited, error: limitedError } = await db.from("provider_attempts")
    .select("id")
    .eq("user_id", userId)
    .eq("provider_key", "cloudflare_flux_schnell")
    .eq("error_code", "rate_limited")
    .gte("created_at", new Date(now - 30 * 60_000).toISOString())
    .limit(1);
  if (limitedError) throw limitedError;
  return (limited ?? []).length > 0;
}

async function recordCloudflareFailure(
  db: SupabaseClient,
  job: JobRow,
  error: unknown,
) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : null;
  const providerCode = typeof error === "object" && error !== null && "providerCode" in error
    ? Number((error as { providerCode: unknown }).providerCode)
    : null;
  const dailyQuota = providerCode === 3036;
  const rateLimited = status === 429;
  const errorCode = dailyQuota ? "daily_free_quota_exhausted" : rateLimited ? "rate_limited" : "provider_unavailable";
  const { error: insertError } = await db.from("provider_attempts").insert({
    user_id: job.user_id,
    job_id: job.id,
    stage_key: "scene_assets",
    capability: "image",
    provider_key: "cloudflare_flux_schnell",
    model_key: "@cf/black-forest-labs/flux-1-schnell",
    attempt_number: 1,
    status: dailyQuota ? "quota_exhausted" : rateLimited ? "rate_limited" : "failed",
    http_status: Number.isFinite(status) ? status : null,
    error_code: errorCode,
    safe_error_message: error instanceof Error ? error.message.slice(0, 300) : "Cloudflare image request failed",
    finished_at: new Date().toISOString(),
  });
  if (insertError) log("provider_attempt_log_failed", { job_id: job.id, provider: "cloudflare_flux_schnell", error: insertError.message.slice(0, 180) });
}

async function generateCloudflareImage(credential: string, prompt: string): Promise<Buffer> {
  const separator = credential.indexOf(":");
  if (separator < 10) throw new Error("Cloudflare credential must contain Account ID and API token");
  const accountId = credential.slice(0, separator);
  const token = credential.slice(separator + 1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, steps: 4 }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      const message = body?.errors?.[0]?.message ?? body?.result?.error ?? "Cloudflare image request failed";
      throw Object.assign(new Error(String(message)), { status: response.status, providerCode: body?.errors?.[0]?.code ?? null });
    }
    const encoded = body?.result?.image ?? body?.image;
    if (typeof encoded !== "string" || encoded.length < 100) {
      throw Object.assign(new Error("Cloudflare returned no image data"), { status: 502 });
    }
    return Buffer.from(encoded, "base64");
  } finally {
    clearTimeout(timeout);
  }
}

const PIPER_BIN = "/opt/piper-venv/bin/piper";
const PIPER_VOICES = [
  { key: "piper_tamil_rasa_female", model: "/opt/piper-models/rasa.onnx", config: "/opt/piper-models/rasa.onnx.json" },
  { key: "piper_tamil_hemalatha", model: "/opt/piper-models/hemalatha.onnx", config: "/opt/piper-models/hemalatha.onnx.json" },
] as const;

function isTamilStory(job: JobRow, story: string): boolean {
  const language = String(job.input?.language ?? job.input?.lang ?? "").toLowerCase();
  return /[\u0B80-\u0BFF]/.test(story) || language.includes("tamil") || language === "ta" || language.startsWith("ta-");
}

async function synthesizeTamilScene(text: string, outputPath: string, workDir: string): Promise<string> {
  let lastError: unknown;
  for (const voice of PIPER_VOICES) {
    try {
      await runCommand(PIPER_BIN, [
        "--model", voice.model,
        "--config", voice.config,
        "--output_file", outputPath,
      ], workDir, text);
      const stat = await readFile(outputPath);
      if (stat.length < 1_000) throw new Error("Piper generated an empty voice file");
      return voice.key;
    } catch (error) {
      lastError = error;
      log("piper_voice_fallback", { failed_voice: voice.key, error: error instanceof Error ? error.message.slice(0, 180) : "voice synthesis failed" });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No local Tamil Piper voice could synthesize this scene");
}

async function renderStoryboard(db: SupabaseClient, job: JobRow): Promise<{
  mp4: Buffer;
  thumbnail: Buffer;
  captions: string;
  narration: Buffer | null;
  voiceModel: string | null;
  sceneCount: number;
  durationSeconds: number;
  visualMode: string;
  imageCount: number;
  sceneAssets: Array<{ sceneNumber: number; title: string; narrationText: string; image: Buffer; durationSeconds: number; source: string }>;
}> {
  const story = typeof job.output?.story === "string" ? job.output.story : "";
  if (!story) throw new Error("The story stage has no saved story text");

  const topic = String(job.input?.topic ?? "RJ Story").slice(0, 100);
  const scenes = splitStoryIntoScenes(story);
  const workDir = await mkdtemp(join(tmpdir(), "rj-render-"));
  try {
    let cloudflareCredential: string | null = null;
    try {
      cloudflareCredential = await loadCloudflareCredential(db, job.user_id);
    } catch (error) {
      log("cloudflare_credential_unavailable", { job_id: job.id, error: error instanceof Error ? error.message.slice(0, 180) : "credential lookup failed" });
    }
    let imageProviderAvailable = Boolean(cloudflareCredential);
    if (imageProviderAvailable) {
      try {
        imageProviderAvailable = !(await cloudflareImageCoolingDown(db, job.user_id));
        if (!imageProviderAvailable) log("cloudflare_image_cooldown_active", { job_id: job.id });
      } catch (error) {
        imageProviderAvailable = false;
        log("cloudflare_cooldown_check_failed", { job_id: job.id, error: error instanceof Error ? error.message.slice(0, 180) : "cooldown lookup failed" });
      }
    }
    let imageCount = 0;
    const pngPaths: string[] = [];
    const sceneAssets: Array<{ sceneNumber: number; title: string; narrationText: string; image: Buffer; source: string }> = [];
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index]!;
      const pngPath = join(workDir, `scene-${String(index + 1).padStart(2, "0")}.png`);
      let generatedImage: Buffer | null = null;
      if (imageProviderAvailable && cloudflareCredential) {
        try {
          generatedImage = await generateCloudflareImage(
            cloudflareCredential,
            `A beautiful child-safe cinematic storybook illustration, wide landscape composition, no text, no letters, no watermark. Story topic: ${topic}. Scene: ${scene.title}. Visual description: ${scene.text.slice(0, 700)}. Warm expressive characters, detailed environment, polished 3D animated film look.`,
          );
          imageCount += 1;
        } catch (error) {
          const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : null;
          imageProviderAvailable = false;
          await recordCloudflareFailure(db, job, error);
          log("cloudflare_image_fallback", {
            job_id: job.id,
            scene: index + 1,
            status,
            reason: status === 429 ? "free_daily_quota_or_rate_limit" : "provider_unavailable",
          });
        }
      }
      const sceneImagePath = join(workDir, `scene-${String(index + 1).padStart(2, "0")}-source.jpg`);
      if (generatedImage) {
        await sharp(generatedImage)
          .resize(1280, 720, { fit: "cover", position: "attention" })
          .jpeg({ quality: 90 })
          .toFile(sceneImagePath);
        const overlay = Buffer.from(buildSceneOverlaySvg({
          title: scene.title, topic, body: scene.text, index, total: scenes.length,
        }));
        await sharp(generatedImage)
          .resize(1280, 720, { fit: "cover", position: "attention" })
          .composite([{ input: overlay }])
          .jpeg({ quality: 88 })
          .toFile(pngPath);
      } else {
        const svg = buildSceneSvg({
          title: scene.title, topic, body: scene.text, index, total: scenes.length,
        });
        await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(sceneImagePath);
        await sharp(Buffer.from(svg)).png().toFile(pngPath);
      }
      sceneAssets.push({
        sceneNumber: index + 1,
        title: scene.title,
        narrationText: scene.text,
        image: await readFile(sceneImagePath),
        source: generatedImage ? "cloudflare_flux_schnell" : "local_vector_fallback",
      });
      pngPaths.push(pngPath);
    }

    let narration: Buffer | null = null;
    let voiceModel: string | null = null;
    let sceneDurations = scenes.map(sceneDurationSeconds);
    if (isTamilStory(job, story)) {
      try {
        const audioPaths: string[] = [];
        const audioDurations: number[] = [];
        const usedVoices: string[] = [];
        for (let index = 0; index < scenes.length; index += 1) {
          const audioPath = join(workDir, `voice-${String(index + 1).padStart(2, "0")}.wav`);
          const usedVoice = await synthesizeTamilScene(scenes[index]!.text, audioPath, workDir);
          const duration = Number.parseFloat(await runCommand("ffprobe", [
            "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", audioPath,
          ], workDir));
          if (!Number.isFinite(duration) || duration <= 0) throw new Error("Piper audio duration is invalid");
          audioPaths.push(audioPath);
          audioDurations.push(duration);
          usedVoices.push(usedVoice);
        }
        const audioConcat = audioPaths.map(path => `file '${path}'`).join("\n") + "\n";
        await writeFile(join(workDir, "voice.txt"), audioConcat, "utf8");
        const narrationPath = join(workDir, "narration.wav");
        await runCommand("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "concat", "-safe", "0", "-i", join(workDir, "voice.txt"),
          "-c:a", "pcm_s16le", narrationPath,
        ], workDir);
        narration = await readFile(narrationPath);
        sceneDurations = audioDurations.map(duration => duration + 0.15);
        voiceModel = [...new Set(usedVoices)].join("+");
      } catch (error) {
        narration = null;
        voiceModel = null;
        sceneDurations = scenes.map(sceneDurationSeconds);
        log("local_tamil_voice_unavailable", { job_id: job.id, error: error instanceof Error ? error.message.slice(0, 250) : "Piper synthesis failed" });
      }
    }

    const concatLines = pngPaths.map((path, index) =>
      `file '${path}'\nduration ${sceneDurations[index]}`
    );
    if (pngPaths.length) concatLines.push(`file '${pngPaths[pngPaths.length - 1]}'`);
    await writeFile(join(workDir, "scenes.txt"), concatLines.join("\n") + "\n", "utf8");

    const mp4Path = join(workDir, "storyboard.mp4");
    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", join(workDir, "scenes.txt"),
    ];
    if (narration) ffmpegArgs.push("-i", join(workDir, "narration.wav"));
    ffmpegArgs.push(
      "-r", "30",
      "-vf", buildKenBurnsFilter(1280, 720),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
      "-movflags", "+faststart",
    );
    if (narration) ffmpegArgs.push("-map", "0:v:0", "-map", "1:a:0", "-af", "apad", "-c:a", "aac", "-b:a", "128k", "-shortest");
    else ffmpegArgs.push("-an");
    ffmpegArgs.push(mp4Path);
    await runCommand("ffmpeg", ffmpegArgs, workDir);

    const probe = await runCommand("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp4Path,
    ], workDir);
    const durationSeconds = Number.parseFloat(probe.trim());
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("FFmpeg produced an invalid or empty video");
    }
    const mp4 = await readFile(mp4Path);
    if (mp4.length < 2_000 || mp4.length > 450 * 1024 * 1024) {
      throw new Error("Rendered video size is outside the permitted range");
    }
    const thumbnail = await sharp(pngPaths[0]!).jpeg({ quality: 82 }).toBuffer();
    return {
      mp4,
      thumbnail,
      captions: buildSrt(scenes, sceneDurations),
      narration,
      voiceModel,
      sceneCount: scenes.length,
      durationSeconds,
      visualMode: imageCount ? "cloudflare_flux_schnell_with_ken_burns_motion" : "vector_story_cards_with_ken_burns_motion",
      imageCount,
      sceneAssets: sceneAssets.map((asset, index) => ({ ...asset, durationSeconds: sceneDurations[index] ?? sceneDurationSeconds(scenes[index]!) })),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function uploadAsset(
  db: SupabaseClient,
  path: string,
  body: Buffer | string,
  contentType: string,
) {
  const { error } = await db.storage.from(BUCKET).upload(path, body, {
    contentType,
    upsert: true,
    cacheControl: "3600",
  });
  if (error) throw error;
}


async function refreshYoutubeAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) throw new Error("YouTube OAuth client credentials are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error("Google rejected the YouTube refresh token (" + response.status + ")");
  }
  return body.access_token;
}

async function uploadPrivateYoutubeVideo(accessToken: string, video: Buffer, title: string, description: string) {
  const metadata = {
    snippet: { title: title.slice(0, 100), description: description.slice(0, 4500), categoryId: "22" },
    status: { privacyStatus: "private", selfDeclaredMadeForKids: true },
  };
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(video.length),
    },
    body: JSON.stringify(metadata),
  });
  const uploadUrl = init.headers.get("location");
  if (!init.ok || !uploadUrl) {
    const detail = await init.text().catch(() => "");
    throw new Error("YouTube upload session could not be created (" + init.status + "): " + detail.slice(0, 300));
  }
  const uploadBody = new ArrayBuffer(video.length);
  new Uint8Array(uploadBody).set(video);
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(video.length) },
    body: uploadBody,
  });
  const body = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || typeof body.id !== "string") {
    throw new Error("YouTube video upload failed (" + uploaded.status + ")");
  }
  return String(body.id);
}

async function processYoutubeUpload(db: SupabaseClient, stage: StageRow): Promise<string> {
  if (!(await claimStage(db, stage))) return "already_claimed";
  activeJob = true;
  let reserved = false;
  let channelRef = "";
  try {
    const job = await loadJob(db, stage);
    const jobOutput = (job?.output ?? {}) as Record<string, any>;
    const render = (jobOutput.render ?? {}) as Record<string, any>;
    if (!job || job.status !== "completed" || typeof render.video_path !== "string") {
      await updateStage(db, stage.job_id, "youtube_upload", {
        status: "blocked", error_code: "render_not_ready",
        error_message: "The rendered video is not ready to upload.",
      });
      return "render_not_ready";
    }

    const { data: approval, error: approvalError } = await db.from("agent_action_audit")
      .select("id,safe_arguments")
      .eq("user_id", job.user_id).eq("tool_key", "youtube.upload").eq("status", "confirmed")
      .contains("safe_arguments", { job_id: job.id })
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (approvalError) throw approvalError;
    if (!approval) {
      await updateStage(db, job.id, "youtube_upload", {
        status: "blocked", error_code: "user_approval_required",
        error_message: "RJ will upload only after you approve this exact video in the app.",
      });
      return "approval_required";
    }

    const { data: channel, error: channelError } = await db.from("youtube_channels")
      .select("id")
      .eq("user_id", job.user_id).eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (channelError) throw channelError;
    if (!channel) {
      await updateStage(db, job.id, "youtube_upload", {
        status: "blocked", error_code: "youtube_not_connected",
        error_message: "Connect a YouTube channel before publishing.",
      });
      return "youtube_not_connected";
    }
    channelRef = channel.id;

    const alreadyUploaded = typeof render.youtube_video_id === "string" ? render.youtube_video_id : "";
    if (alreadyUploaded) {
      const { error: completeError } = await db.rpc("rj_complete_youtube_upload", {
        p_user_id: job.user_id, p_channel_ref: channelRef, p_job_id: job.id,
        p_youtube_video_id: alreadyUploaded,
      });
      if (completeError) throw completeError;
      await updateStage(db, job.id, "youtube_upload", {
        status: "succeeded", output: { youtube_video_id: alreadyUploaded, privacy_status: "private", recovered: true },
        finished_at: new Date().toISOString(), error_code: null, error_message: null,
      });
      await db.from("agent_action_audit").update({ status: "succeeded", result_summary: "YouTube video uploaded privately: " + alreadyUploaded, finished_at: new Date().toISOString() }).eq("id", approval.id);
      return "upload_recovered";
    }

    const { data: reservation, error: reserveError } = await db.rpc("rj_reserve_youtube_upload", {
      p_user_id: job.user_id, p_channel_ref: channelRef, p_job_id: job.id,
    });
    if (reserveError) throw reserveError;
    if (reservation?.allowed !== true) {
      await updateStage(db, job.id, "youtube_upload", {
        status: "blocked",
        error_code: reservation?.reason ?? "daily_upload_limit_reached",
        error_message: reservation?.reason === "daily_limit_reached"
          ? "Daily YouTube upload limit reached. Try again after the channel-local day resets."
          : "YouTube upload is not available for this job.",
        output: { daily_limit: reservation?.limit ?? 2, used: reservation?.used ?? 2, remaining: reservation?.remaining ?? 0 },
      });
      return "daily_limit_or_reservation_blocked";
    }
    reserved = true;

    const { data: refreshToken, error: tokenError } = await db.rpc("rj_get_youtube_refresh_token", { p_channel_ref: channelRef });
    if (tokenError || typeof refreshToken !== "string" || !refreshToken) throw new Error("RJ could not load the YouTube refresh token from Supabase Vault");
    const accessToken = await refreshYoutubeAccessToken(refreshToken);
    const { data: videoBlob, error: downloadError } = await db.storage.from(BUCKET).download(String(render.video_path));
    if (downloadError || !videoBlob) throw new Error("RJ could not read the rendered video from private storage");
    const video = Buffer.from(await videoBlob.arrayBuffer());
    if (!video.length || video.length > 450 * 1024 * 1024) throw new Error("Rendered video size is outside the supported upload range");

    const title = String(job.input?.topic ?? "RJ Kids Story");
    const description = "A children's story created with RJ.\n\n#KidsStories #TamilStories #RJ";
    const videoId = await uploadPrivateYoutubeVideo(accessToken, video, title, description);

    const updatedOutput = {
      ...jobOutput,
      render: { ...render, youtube_video_id: videoId, youtube_url: "https://www.youtube.com/watch?v=" + videoId, youtube_status: "uploaded_private" },
    };
    const { error: saveError } = await db.from("jobs").update({
      output: updatedOutput, current_stage: "youtube_upload", updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("user_id", job.user_id);
    if (saveError) throw saveError;

    const { error: completeError } = await db.rpc("rj_complete_youtube_upload", {
      p_user_id: job.user_id, p_channel_ref: channelRef, p_job_id: job.id, p_youtube_video_id: videoId,
    });
    if (completeError) throw completeError;
    reserved = false;

    await updateStage(db, job.id, "youtube_upload", {
      status: "succeeded", selected_provider: "youtube_data_api_v3",
      output: { youtube_video_id: videoId, youtube_url: "https://www.youtube.com/watch?v=" + videoId, privacy_status: "private", file_size_bytes: video.length },
      finished_at: new Date().toISOString(), error_code: null, error_message: null,
    });
    await db.from("agent_action_audit").update({
      status: "succeeded", result_summary: "Uploaded privately to YouTube: " + videoId,
      finished_at: new Date().toISOString(),
    }).eq("id", approval.id);
    log("youtube_upload_completed", { job_id: job.id, video_id: videoId, privacy_status: "private", bytes: video.length });
    return "youtube_uploaded_private";
  } catch (error) {
    if (reserved && channelRef) {
      await db.rpc("rj_release_youtube_upload", {
        p_user_id: stage.user_id, p_channel_ref: channelRef, p_job_id: stage.job_id,
      });
    }
    const message = error instanceof Error ? error.message : "YouTube upload failed";
    await updateStage(db, stage.job_id, "youtube_upload", {
      status: "failed", error_code: "youtube_upload_failed",
      error_message: message.slice(0, 500), finished_at: new Date().toISOString(),
    });
    log("youtube_upload_failed", { job_id: stage.job_id, error: message.slice(0, 300) });
    return "youtube_upload_failed";
  } finally {
    activeJob = false;
  }
}

async function processStage(db: SupabaseClient, stage: StageRow) {
  if (stage.stage_key === "youtube_upload") return await processYoutubeUpload(db, stage);
  if (!(await storyStageIsReady(db, stage.job_id))) return "story_not_ready";
  const claimed = await claimStage(db, stage);
  if (!claimed) return "already_claimed";
  activeJob = true;

  try {
    const job = await loadJob(db, stage);
    if (!job || typeof job.output?.story !== "string") {
      await updateStage(db, stage.job_id, "scene_assets", {
        status: "failed",
        error_code: "story_missing",
        error_message: "The story output is missing; the render stage cannot continue.",
        finished_at: new Date().toISOString(),
      });
      return "story_missing";
    }

    const result = await renderStoryboard(db, job);
    const basePath = `${job.user_id}/${job.id}`;
    const videoPath = `${basePath}/storyboard.mp4`;
    const thumbnailPath = `${basePath}/thumbnail.jpg`;
    const captionsPath = `${basePath}/captions.srt`;
    const narrationPath = result.narration ? `${basePath}/narration.wav` : null;

    await uploadAsset(db, videoPath, result.mp4, "video/mp4");
    await uploadAsset(db, thumbnailPath, result.thumbnail, "image/jpeg");
    await uploadAsset(db, captionsPath, result.captions, "application/x-subrip");
    if (result.narration && narrationPath) await uploadAsset(db, narrationPath, result.narration, "audio/wav");
    const sceneTimeline = [];
    for (const scene of result.sceneAssets) {
      const scenePath = `${basePath}/scenes/scene-${String(scene.sceneNumber).padStart(2, "0")}.jpg`;
      await uploadAsset(db, scenePath, scene.image, "image/jpeg");
      sceneTimeline.push({
        scene_number: scene.sceneNumber,
        title: scene.title,
        narration_text: scene.narrationText,
        image_path: scenePath,
        duration_seconds: scene.durationSeconds,
        image_source: scene.source,
        motion: "ken_burns_slow_zoom",
      });
    }

    const now = new Date().toISOString();
    await updateStage(db, job.id, "scene_assets", {
      status: "succeeded",
      selected_provider: result.imageCount ? "cloudflare_flux_schnell" : "rj_vector_story_cards",
      output: {
        asset_kind: result.visualMode,
        generated_image_count: result.imageCount,
        scene_count: result.sceneCount,
        note: result.imageCount ? "Free-tier Cloudflare FLUX illustrations were generated where available; remaining scenes use local vector fallback. No paid provider is used." : "Cloudflare Free image generation was unavailable or not configured; local vector story cards were used. No paid provider is used.",
      },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "voice_audio", {
      status: result.narration ? "succeeded" : "skipped",
      selected_provider: result.voiceModel ?? undefined,
      output: result.narration ? { narration: "generated_locally", voice_model: result.voiceModel, bucket: BUCKET, path: narrationPath, license: "Piper Tamil model licenses documented in renderer README" } : { narration: "not_generated", reason: "No compatible local Tamil voice was available or the story was not Tamil." },
      error_code: result.narration ? null : "local_voice_unavailable_or_not_tamil",
      error_message: result.narration ? null : "No paid speech API was called; the video remains silent.",
      finished_at: now,
    });
    await updateStage(db, job.id, "captions", {
      status: "succeeded",
      output: { bucket: BUCKET, path: captionsPath, timing: result.narration ? "scene-level speech duration alignment" : "scene-card timing; not speech-aligned" },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "timeline_edit", {
      status: "succeeded",
      selected_provider: "ffmpeg",
      output: { codec: "h264", width: 1280, height: 720, fps: 30, audio: Boolean(result.narration), audio_codec: result.narration ? "aac" : null, motion_engine: "ffmpeg_ken_burns" },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "render_export", {
      status: "succeeded",
      selected_provider: "ffmpeg",
      output: {
        bucket: BUCKET,
        video_path: videoPath,
        thumbnail_path: thumbnailPath,
        captions_path: captionsPath,
        narration_path: narrationPath,
        duration_seconds: result.durationSeconds,
        file_size_bytes: result.mp4.length,
        mime_type: "video/mp4",
      },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "quality_check", {
      status: "succeeded",
      selected_provider: "ffprobe",
      output: { valid_mp4: true, duration_seconds: result.durationSeconds, file_size_bytes: result.mp4.length },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "metadata_thumbnail", {
      status: "succeeded",
      selected_provider: "sharp",
      output: { thumbnail_path: thumbnailPath },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "youtube_upload", {
      status: "blocked",
      error_code: "youtube_not_connected",
      error_message: "Connect a YouTube channel before publishing this rendered video.",
    });
    await updateStage(db, job.id, "youtube_schedule_verify", {
      status: "blocked",
      error_code: "youtube_not_connected",
      error_message: "YouTube scheduling is unavailable until a channel is connected.",
    });

    const { error: jobUpdateError } = await db.from("jobs").update({
      status: "completed",
      current_stage: "render_export",
      output: {
        ...job.output,
        stage: "rendered",
        render: {
          bucket: BUCKET,
          video_path: videoPath,
          thumbnail_path: thumbnailPath,
          captions_path: captionsPath,
          duration_seconds: result.durationSeconds,
          file_size_bytes: result.mp4.length,
          scene_count: result.sceneCount,
          visual_mode: result.visualMode,
          generated_image_count: result.imageCount,
          scene_asset_count: sceneTimeline.length,
          timeline: { version: 1, motion_engine: "ffmpeg_ken_burns", scenes: sceneTimeline },
          narration: result.narration ? "generated_locally" : "not_generated",
          voice_model: result.voiceModel,
          narration_path: narrationPath,
          audio: Boolean(result.narration),
          youtube_status: "not_connected",
        },
        rendered_at: now,
      },
      error_code: null,
      error_message: null,
      updated_at: now,
    }).eq("id", job.id).eq("user_id", job.user_id);
    if (jobUpdateError) throw jobUpdateError;

    log("render_completed", {
      job_id: job.id,
      scene_count: result.sceneCount,
      duration_seconds: result.durationSeconds,
      file_size_bytes: result.mp4.length,
      narration: Boolean(result.narration),
      voice_model: result.voiceModel,
      generated_image_count: result.imageCount,
      scene_asset_count: sceneTimeline.length,
      motion_engine: "ffmpeg_ken_burns",
    });
    return "rendered";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown renderer error";
    await updateStage(db, stage.job_id, "scene_assets", {
      status: "failed",
      error_code: "render_pipeline_failed",
      error_message: message.slice(0, 500),
      finished_at: new Date().toISOString(),
    });
    await db.from("jobs").update({
      status: "failed",
      error_code: "render_pipeline_failed",
      error_message: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", stage.job_id).eq("user_id", stage.user_id);
    log("render_failed", { job_id: stage.job_id, error: message.slice(0, 500) });
    return "failed";
  } finally {
    activeJob = false;
  }
}

async function pollOnce(db: SupabaseClient) {
  const stages = await loadReadyStages(db);
  for (const stage of stages) {
    if (stopping) break;
    try {
      const outcome = await processStage(db, stage);
      if (outcome !== "story_not_ready" && outcome !== "already_claimed") {
        log("stage_processed", { job_id: stage.job_id, outcome });
      }
    } catch (error) {
      log("poll_stage_error", {
        job_id: stage.job_id,
        error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
      });
    }
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log("worker_started", { poll_ms: POLL_MS, batch_size: BATCH_SIZE, bucket: BUCKET });
  while (!stopping) {
    try {
      await pollOnce(supabase);
    } catch (error) {
      log("poll_error", { error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error" });
    }
    if (!stopping) await sleep(POLL_MS);
  }
  log("worker_stopped", { active_job: activeJob });
}

process.on("SIGTERM", () => { stopping = true; log("sigterm_received"); });
process.on("SIGINT", () => { stopping = true; log("sigint_received"); });

main().catch((error) => {
  log("fatal_error", { error: error instanceof Error ? error.message : "Unknown error" });
  process.exitCode = 1;
});