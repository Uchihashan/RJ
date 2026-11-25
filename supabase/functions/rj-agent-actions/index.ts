import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TOOL_KEYS = [
  "video.create", "reminder.create", "navigation.open",
  "youtube.upload", "youtube.schedule", "provider.connect", "provider.disconnect",
] as const;
type ToolKey = typeof TOOL_KEYS[number];
const url = Deno.env.get("SUPABASE_URL") ?? "";
const secretMapRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
const secretKey = secretMapRaw ? (JSON.parse(secretMapRaw) as Record<string, string>).default : "";
const adminKey = secretKey || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!url || !adminKey) throw new Error("RJ agent actions is missing server-side Supabase credentials");
const admin = createClient(url, adminKey, {
  global: { headers: secretKey ? { Authorization: "" } : {} },
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function safeArguments(tool: ToolKey, value: unknown): Record<string, unknown> {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (tool === "video.create") return { topic: String(input.topic ?? "").trim().slice(0, 180) };
  if (tool === "reminder.create") return {
    title: String(input.title ?? "").trim().slice(0, 120),
    time: String(input.time ?? "").slice(0, 5),
  };
  if (tool === "youtube.upload") return { job_id: String(input.job_id ?? "").trim() };
  if (tool === "navigation.open") {
    const tab = String(input.tab ?? "");
    return { tab: ["Home", "Create", "Edit", "Tools", "Schedule", "Settings"].includes(tab) ? tab : "" };
  }
  return {};
}
function validTool(value: unknown): value is ToolKey {
  return typeof value === "string" && (TOOL_KEYS as readonly string[]).includes(value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "Sign in to manage RJ permissions." }, 401);
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return json({ error: "Your RJ session is invalid. Sign in again." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const action = body.action;

  if (action === "list") {
    const { data, error } = await admin.from("agent_tool_permissions")
      .select("tool_key,enabled,requires_confirmation,granted_at,revoked_at")
      .eq("user_id", user.id);
    if (error) return json({ error: "Could not load RJ tool permissions." }, 500);
    const byKey = new Map((data ?? []).map((row: any) => [row.tool_key, row]));
    return json({ permissions: TOOL_KEYS.map((tool_key) => {
      const row = byKey.get(tool_key) as any;
      return {
        tool_key, enabled: row?.enabled === true,
        requires_confirmation: row?.requires_confirmation !== false,
        granted_at: row?.granted_at ?? null, revoked_at: row?.revoked_at ?? null,
      };
    }) });
  }

  if (action === "set_permission") {
    if (!validTool(body.tool_key) || typeof body.enabled !== "boolean") {
      return json({ error: "A valid tool and enabled state are required." }, 400);
    }
    const now = new Date().toISOString();
    const enabled = body.enabled;
    const { error } = await admin.from("agent_tool_permissions").upsert({
      user_id: user.id, tool_key: body.tool_key, enabled,
      requires_confirmation: true,
      granted_at: enabled ? now : null,
      revoked_at: enabled ? null : now,
      updated_at: now,
    }, { onConflict: "user_id,tool_key" });
    if (error) return json({ error: "Could not update this RJ permission." }, 500);
    return json({ ok: true, tool_key: body.tool_key, enabled, requires_confirmation: true });
  }

  if (action === "begin_action") {
    if (!validTool(body.tool_key) || body.confirmed !== true) {
      return json({ error: "A valid tool and explicit user confirmation are required." }, 400);
    }
    const tool = body.tool_key;
    const args = safeArguments(tool, body.arguments);
    if (tool === "video.create" && !args.topic) return json({ error: "Video topic is required." }, 400);
    if (tool === "youtube.upload" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(args.job_id ?? ""))) return json({ error: "A valid rendered video project is required." }, 400);
    if (tool === "reminder.create" && (!args.title || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(args.time)))) {
      return json({ error: "A valid reminder title and 24-hour time are required." }, 400);
    }
    if (tool === "navigation.open" && !args.tab) return json({ error: "A valid RJ screen is required." }, 400);

    if (tool === "youtube.upload") {
      const { data: uploadJob, error: uploadJobError } = await admin.from("jobs")
        .select("id,status,output")
        .eq("id", String(args.job_id)).eq("user_id", user.id)
        .eq("job_type", "video_generation").maybeSingle();
      if (uploadJobError) return json({ error: "Could not verify the video project." }, 500);
      if (!uploadJob || uploadJob.status !== "completed" || typeof uploadJob.output?.render?.video_path !== "string") {
        return json({ error: "Only a completed rendered video can be approved for upload." }, 409);
      }
    }

    const requestId = crypto.randomUUID();
    const { data: permission, error: permissionError } = await admin.from("agent_tool_permissions")
      .select("enabled,requires_confirmation")
      .eq("user_id", user.id).eq("tool_key", tool).maybeSingle();
    if (permissionError) return json({ error: "Could not verify RJ tool permission." }, 500);
    if (!permission?.enabled) {
      const { error: deniedError } = await admin.from("agent_action_audit").insert({
        user_id: user.id, request_id: requestId, tool_key: tool,
        status: "denied", safe_arguments: args, result_summary: "Tool permission is disabled.",
        finished_at: new Date().toISOString(),
      });
      if (deniedError) return json({ error: "Permission is disabled and the denial audit could not be saved." }, 500);
      return json({ error: "Permission is disabled. Enable this tool in RJ Settings first." }, 403);
    }
    if (permission.requires_confirmation && body.confirmed !== true) return json({ error: "This action requires confirmation." }, 403);

    const { error: auditError } = await admin.from("agent_action_audit").insert({
      user_id: user.id, request_id: requestId, tool_key: tool,
      status: "proposed", safe_arguments: args,
    });
    if (auditError) return json({ error: "RJ could not record the action audit; no action was run." }, 500);
    const { error: confirmError } = await admin.from("agent_action_audit").update({
      status: "confirmed", result_summary: "User confirmed in RJ app.",
    }).eq("user_id", user.id).eq("request_id", requestId).eq("status", "proposed");
    if (confirmError) return json({ error: "RJ could not confirm the action audit; no action was run." }, 500);
    if (tool === "youtube.upload") {
      const { error: stageError } = await admin.from("job_stages").update({
        status: "pending", locked_at: null, error_code: null, error_message: null, run_after: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("job_id", String(args.job_id)).eq("user_id", user.id).eq("stage_key", "youtube_upload");
      if (stageError) return json({ error: "Approval was recorded, but RJ could not queue the upload stage." }, 500);
    }
    return json({ ok: true, request_id: requestId, tool_key: tool });
  }

  if (action === "finish_action") {
    const requestId = String(body.request_id ?? "");
    const status = body.status;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
      || !["succeeded", "failed", "cancelled"].includes(String(status))) {
      return json({ error: "Invalid audit completion request." }, 400);
    }
    const summary = String(body.result_summary ?? "").replace(/[\r\n\t]/g, " ").slice(0, 240);
    const { data, error } = await admin.from("agent_action_audit").update({
      status, result_summary: summary || null, finished_at: new Date().toISOString(),
    }).eq("user_id", user.id).eq("request_id", requestId).eq("status", "confirmed")
      .select("id").maybeSingle();
    if (error) return json({ error: "Could not finish the RJ action audit." }, 500);
    if (!data) return json({ error: "Action audit not found or already completed." }, 409);
    return json({ ok: true, status });
  }

  return json({ error: "Unsupported RJ agent action." }, 400);
});
