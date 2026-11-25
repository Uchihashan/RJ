import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
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

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
    .eq("stage_key", "scene_assets")
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

async function renderStoryboard(job: JobRow): Promise<{
  mp4: Buffer;
  thumbnail: Buffer;
  captions: string;
  sceneCount: number;
  durationSeconds: number;
}> {
  const story = typeof job.output?.story === "string" ? job.output.story : "";
  if (!story) throw new Error("The story stage has no saved story text");

  const topic = String(job.input?.topic ?? "RJ Story").slice(0, 100);
  const scenes = splitStoryIntoScenes(story);
  const workDir = await mkdtemp(join(tmpdir(), "rj-render-"));
  try {
    const pngPaths: string[] = [];
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index]!;
      const svg = buildSceneSvg({
        title: scene.title,
        topic,
        body: scene.text,
        index,
        total: scenes.length,
      });
      const pngPath = join(workDir, `scene-${String(index + 1).padStart(2, "0")}.png`);
      await sharp(Buffer.from(svg)).png().toFile(pngPath);
      pngPaths.push(pngPath);
    }

    const concatLines = pngPaths.map((path, index) =>
      `file '${path}'\nduration ${sceneDurationSeconds(scenes[index]!)}`
    );
    if (pngPaths.length) concatLines.push(`file '${pngPaths[pngPaths.length - 1]}'`);
    await writeFile(join(workDir, "scenes.txt"), concatLines.join("\n") + "\n", "utf8");

    const mp4Path = join(workDir, "storyboard.mp4");
    await runCommand("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", join(workDir, "scenes.txt"),
      "-r", "30",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
      "-movflags", "+faststart",
      mp4Path,
    ], workDir);

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
      captions: buildSrt(scenes),
      sceneCount: scenes.length,
      durationSeconds,
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

async function processStage(db: SupabaseClient, stage: StageRow) {
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

    const result = await renderStoryboard(job);
    const basePath = `${job.user_id}/${job.id}`;
    const videoPath = `${basePath}/storyboard.mp4`;
    const thumbnailPath = `${basePath}/thumbnail.jpg`;
    const captionsPath = `${basePath}/captions.srt`;

    await uploadAsset(db, videoPath, result.mp4, "video/mp4");
    await uploadAsset(db, thumbnailPath, result.thumbnail, "image/jpeg");
    await uploadAsset(db, captionsPath, result.captions, "application/x-subrip");

    const now = new Date().toISOString();
    await updateStage(db, job.id, "scene_assets", {
      status: "succeeded",
      selected_provider: "rj_vector_story_cards",
      output: {
        asset_kind: "vector_story_cards",
        scene_count: result.sceneCount,
        note: "No paid image-generation API was called. These are generated text-led scene cards, not AI photographs or illustrations.",
      },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "voice_audio", {
      status: "skipped",
      output: { narration: "not_generated", reason: "No approved speech provider is enabled." },
      error_code: "speech_provider_disabled",
      error_message: "Video was rendered without narration; no speech API was called.",
      finished_at: now,
    });
    await updateStage(db, job.id, "captions", {
      status: "succeeded",
      output: { bucket: BUCKET, path: captionsPath, timing: "scene-card timing; not speech-aligned" },
      finished_at: now,
      error_code: null,
      error_message: null,
    });
    await updateStage(db, job.id, "timeline_edit", {
      status: "succeeded",
      selected_provider: "ffmpeg",
      output: { codec: "h264", width: 1280, height: 720, fps: 30, audio: false },
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
          visual_mode: "vector_story_cards",
          narration: "not_generated",
          audio: false,
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
      narration: false,
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