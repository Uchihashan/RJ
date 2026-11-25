import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_MAP = Deno.env.get("SUPABASE_SECRET_KEYS");
const SECRET_KEY = SECRET_MAP ? (JSON.parse(SECRET_MAP) as Record<string,string>).default : "";
const ADMIN_KEY = SECRET_KEY || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_CLIENT_ID = Deno.env.get("YOUTUBE_OAUTH_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("YOUTUBE_OAUTH_CLIENT_SECRET") ?? "";
const BUCKET = "rj-renders";
if (!SUPABASE_URL || !ADMIN_KEY) throw new Error("Missing server-side Supabase credentials");
const admin = createClient(SUPABASE_URL, ADMIN_KEY, {
  global: { headers: SECRET_KEY ? { Authorization: "" } : {} },
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ error: "Sign in to upload a video." }, 401);
  const { data: auth, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !auth.user) return json({ error: "Your RJ session is invalid." }, 401);

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const jobId = String(input.job_id ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return json({ error: "A valid video project ID is required." }, 400);
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json({ error: "YouTube OAuth server credentials are not configured." }, 503);
  }

  let channelRef = "";
  let reserved = false;
  let auditId = "";
  try {
    const { data: job, error: jobError } = await admin.from("jobs")
      .select("id,user_id,job_type,status,input,output")
      .eq("id", jobId).eq("user_id", auth.user.id).eq("job_type", "video_generation").maybeSingle();
    if (jobError) throw jobError;
    const output = (job?.output ?? {}) as Record<string, any>;
    const render = (output.render ?? {}) as Record<string, any>;
    if (!job || job.status !== "completed" || typeof render.video_path !== "string") {
      return json({ error: "Only a completed rendered video can be uploaded." }, 409);
    }
    if (typeof render.youtube_video_id === "string" && render.youtube_video_id) {
      const { data: existingChannel } = await admin.from("youtube_channels").select("id")
        .eq("user_id", auth.user.id).eq("is_active", true)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (existingChannel?.id) {
        await admin.rpc("rj_complete_youtube_upload", {
          p_user_id: auth.user.id, p_channel_ref: existingChannel.id,
          p_job_id: jobId, p_youtube_video_id: render.youtube_video_id,
        });
      }
      await admin.from("job_stages").update({
        status: "succeeded", output: { youtube_video_id: render.youtube_video_id, youtube_url: render.youtube_url, privacy_status: "private" },
        error_code: null, error_message: null, finished_at: new Date().toISOString(),
      }).eq("job_id", jobId).eq("user_id", auth.user.id).eq("stage_key", "youtube_upload");
      return json({ ok: true, video_id: render.youtube_video_id, video_url: render.youtube_url, already_uploaded: true });
    }

    const { data: approval, error: approvalError } = await admin.from("agent_action_audit")
      .select("id")
      .eq("user_id", auth.user.id).eq("tool_key", "youtube.upload").eq("status", "confirmed")
      .contains("safe_arguments", { job_id: jobId })
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (approvalError) throw approvalError;
    if (!approval) return json({ error: "Approve this exact video in RJ before uploading." }, 403);
    auditId = approval.id;

    const { data: channel, error: channelError } = await admin.from("youtube_channels")
      .select("id").eq("user_id", auth.user.id).eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (channelError) throw channelError;
    if (!channel) {
      await admin.from("job_stages").update({
        status: "blocked", error_code: "youtube_not_connected",
        error_message: "Connect a YouTube channel before uploading.",
        updated_at: new Date().toISOString(),
      }).eq("job_id", jobId).eq("user_id", auth.user.id).eq("stage_key", "youtube_upload");
      return json({ error: "Connect a YouTube channel in RJ Settings first." }, 409);
    }
    channelRef = channel.id;

    const { data: claimed, error: claimError } = await admin.rpc("rj_claim_job_stage", {
      p_job_id: jobId, p_user_id: auth.user.id, p_stage_key: "youtube_upload", p_lease_seconds: 1800,
    });
    if (claimError) throw claimError;
    if (claimed !== true) return json({ error: "This video is already being uploaded or the upload stage is not ready." }, 409);

    const { data: reservation, error: reserveError } = await admin.rpc("rj_reserve_youtube_upload", {
      p_user_id: auth.user.id, p_channel_ref: channelRef, p_job_id: jobId,
    });
    if (reserveError) throw reserveError;
    if (reservation?.allowed !== true) {
      await admin.from("job_stages").update({
        status: "blocked", error_code: reservation?.reason ?? "daily_limit_reached",
        error_message: "Daily YouTube upload limit reached or this video was already published.",
        output: { daily_limit: reservation?.limit ?? 2, used: reservation?.used ?? 2, remaining: reservation?.remaining ?? 0 },
        updated_at: new Date().toISOString(),
      }).eq("job_id", jobId).eq("user_id", auth.user.id).eq("stage_key", "youtube_upload");
      return json({ error: "Daily YouTube upload limit reached. Try again after the channel-local day resets.", limit: reservation?.limit ?? 2, remaining: reservation?.remaining ?? 0 }, 429);
    }
    reserved = true;

    const { data: refreshToken, error: tokenError } = await admin.rpc("rj_get_youtube_refresh_token", { p_channel_ref: channelRef });
    if (tokenError || typeof refreshToken !== "string" || !refreshToken) throw new Error("Could not read the YouTube refresh token from Supabase Vault.");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken, grant_type: "refresh_token",
      }),
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokenBody.access_token !== "string") {
      throw new Error("Google rejected the saved YouTube refresh token (" + tokenResponse.status + "). Reconnect YouTube in RJ Settings.");
    }

    const { data: videoBlob, error: downloadError } = await admin.storage.from(BUCKET).download(render.video_path);
    if (downloadError || !videoBlob) throw new Error("RJ could not download the rendered video from private storage.");
    if (videoBlob.size < 2000 || videoBlob.size > 100 * 1024 * 1024) {
      throw new Error("This free upload path supports rendered videos up to 100 MB. The current file is " + Math.round(videoBlob.size / 1024 / 1024) + " MB.");
    }

    const title = String(job.input?.topic ?? "RJ Kids Story").slice(0, 100);
    const metadata = {
      snippet: {
        title,
        description: "A children's story created with RJ.\n\n#KidsStories #TamilStories #RJ",
        categoryId: "22",
      },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: true },
    };
    const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokenBody.access_token,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(videoBlob.size),
      },
      body: JSON.stringify(metadata),
    });
    const uploadUrl = init.headers.get("location");
    if (!init.ok || !uploadUrl) throw new Error("YouTube could not create an upload session (" + init.status + ").");
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(videoBlob.size) },
      body: videoBlob,
    });
    const uploadBody = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || typeof uploadBody.id !== "string") {
      throw new Error("YouTube upload failed (" + uploadResponse.status + ").");
    }

    const videoId = String(uploadBody.id);
    const videoUrl = "https://www.youtube.com/watch?v=" + videoId;
    const now = new Date().toISOString();
    const { error: saveError } = await admin.from("jobs").update({
      output: { ...output, render: { ...render, youtube_video_id: videoId, youtube_url: videoUrl, youtube_status: "uploaded_private" } },
      current_stage: "youtube_upload", updated_at: now,
    }).eq("id", jobId).eq("user_id", auth.user.id);
    if (saveError) throw saveError;

    const { error: completeError } = await admin.rpc("rj_complete_youtube_upload", {
      p_user_id: auth.user.id, p_channel_ref: channelRef, p_job_id: jobId, p_youtube_video_id: videoId,
    });
    if (completeError) throw completeError;
    reserved = false;
    await admin.from("job_stages").update({
      status: "succeeded", selected_provider: "youtube_data_api_v3",
      output: { youtube_video_id: videoId, youtube_url: videoUrl, privacy_status: "private", file_size_bytes: videoBlob.size },
      error_code: null, error_message: null, finished_at: now, updated_at: now,
    }).eq("job_id", jobId).eq("user_id", auth.user.id).eq("stage_key", "youtube_upload");
    await admin.from("agent_action_audit").update({
      status: "succeeded", result_summary: "Uploaded privately to YouTube: " + videoId, finished_at: now,
    }).eq("id", auditId);
    return json({ ok: true, video_id: videoId, video_url: videoUrl, privacy_status: "private" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "YouTube upload failed.";
    if (reserved && channelRef) {
      await admin.rpc("rj_release_youtube_upload", {
        p_user_id: auth.user.id, p_channel_ref: channelRef, p_job_id: jobId,
      });
    }
    await admin.from("job_stages").update({
      status: "failed", error_code: "youtube_upload_failed", error_message: message.slice(0, 500),
      finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("job_id", jobId).eq("user_id", auth.user.id).eq("stage_key", "youtube_upload");
    if (auditId) await admin.from("agent_action_audit").update({
      status: "failed", result_summary: message.slice(0, 240), finished_at: new Date().toISOString(),
    }).eq("id", auditId);
    return json({ error: message }, 500);
  }
});
