import { createClient } from "npm:@supabase/supabase-js@2";
import {
  classifyProviderFailure,
  cooldownUntil,
  selectEligibleProviders,
  type ProviderHealth,
} from "../_shared/provider-registry.ts";
import { agentSystemPrompt, parseAgentOutput, type AgentContext } from "./agent-response.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const url = Deno.env.get("SUPABASE_URL") ?? "";
const secretMapRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
const secretKey = secretMapRaw ? (JSON.parse(secretMapRaw) as Record<string, string>).default : "";
const adminKey = secretKey || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!url || !adminKey) throw new Error("RJ assistant is missing server-side Supabase credentials");

const admin = createClient(url, adminKey, {
  global: { headers: secretKey ? { Authorization: "" } : {} },
  auth: { persistSession: false, autoRefreshToken: false },
});

type ChatMessage = { role: "user" | "assistant"; content: string };

async function callGemini(apiKey: string, messages: ChatMessage[], context: AgentContext) {
  const prompt = [
    agentSystemPrompt(context),
    ...messages.slice(-16).map((m) => (m.role === "user" ? "User: " : "RJ: ") + m.content),
    "RJ:",
  ].join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ model: "gemini-3.5-flash-lite", input: prompt, store: false }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ?? "Gemini request failed (" + res.status + ")");
    const stepText = Array.isArray(data?.steps)
      ? data.steps.filter((s: { type?: string }) => s.type === "model_output")
        .flatMap((s: { content?: { type?: string; text?: string }[] }) => s.content ?? [])
        .filter((p: { type?: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "").join("\n")
      : "";
    const answer = String(data?.output_text ?? stepText).trim();
    if (!answer) throw new Error("RJ received an empty response from Gemini");
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

async function callGroqFree(apiKey: string, messages: ChatMessage[], context: AgentContext) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: agentSystemPrompt(context) },
          ...messages.slice(-16),
        ],
        temperature: 0.7,
        max_tokens: 1800,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? "Groq Free-tier request failed (" + res.status + ")"), { status: res.status });
    const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!answer) throw Object.assign(new Error("RJ received an empty response from Groq"), { status: 502 });
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenRouter(apiKey: string, messages: ChatMessage[], context: AgentContext) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/Uchihashan/RJ",
      "X-Title": "RJ AI",
    },
    body: JSON.stringify({
      model: "openrouter/free",
      messages: [
        { role: "system", content: "You are RJ, a practical personal AI assistant. Reply in the user's language (Tamil, Tanglish, or English). Be honest about actions and ask before paid or external actions." },
        ...messages.slice(-16),
      ],
      temperature: 0.7,
      max_tokens: 1800,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? "OpenRouter request failed (" + res.status + ")");
  const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!answer) throw new Error("RJ received an empty response from OpenRouter");
  return answer;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "Sign in to use RJ AI." }, 401);

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Your RJ session is invalid. Please sign in again." }, 401);

  let input: { messages?: ChatMessage[] };
  try { input = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (!messages.length || messages.length > 24) return json({ error: "Send between 1 and 24 chat messages." }, 400);
  const clean = messages.map((m) => ({
    role: m?.role === "assistant" ? "assistant" as const : "user" as const,
    content: typeof m?.content === "string" ? m.content.trim().slice(0, 6000) : "",
  })).filter((m) => m.content);
  if (!clean.length || clean[clean.length - 1].role !== "user") return json({ error: "A user message is required." }, 400);

  const { data: rows, error: keyError } = await admin.rpc("rj_get_provider_keys", { p_user_id: authData.user.id });
  if (keyError) {
    console.error("RJ provider lookup failed", keyError.message);
    return json({ error: "RJ could not load your connected AI provider. Check Settings." }, 503);
  }
  const { data: policyRow, error: policyError } = await admin.from("provider_user_policies")
    .select("allow_paid_providers,monthly_budget_usd")
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (policyError) {
    console.error("RJ provider policy lookup failed", policyError.message);
    return json({ error: "RJ could not load your provider spending settings." }, 503);
  }
  const policy = {
    allowPaidProviders: policyRow?.allow_paid_providers === true,
    monthlyBudgetUsd: Number(policyRow?.monthly_budget_usd ?? 0),
  };
  const keys = new Map<string, string>((rows ?? []).map((r: { provider: string; api_key: string }) => [r.provider, r.api_key]));
  const { data: healthRows, error: healthError } = await admin.from("provider_health")
    .select("provider_key,state,cooldown_until")
    .eq("user_id", authData.user.id)
    .eq("capability", "text");
  if (healthError) return json({ error: "RJ could not load provider availability." }, 503);
  const providers = selectEligibleProviders("text", keys, (healthRows ?? []) as ProviderHealth[], policy);
  if (!providers.length) {
    const paidConsentNeeded = keys.has("gemini") && !policy.allowPaidProviders && !keys.has("openrouter") && !keys.has("groq");
    return json({
      error: paidConsentNeeded
        ? "Gemini may be billable on your account. RJ will not use it until paid-provider cost metering and explicit spending controls are ready. Connect OpenRouter Free or Groq Free for now."
        : "AI provider not connected or currently cooling down. Connect a free text provider in RJ Settings.",
      code: paidConsentNeeded ? "paid_provider_consent_required" : "provider_unavailable",
    }, paidConsentNeeded ? 402 : 424);
  }

  const failures: string[] = [];
  for (const provider of providers) {
    const { data: attempt, error: attemptError } = await admin.from("provider_attempts").insert({
      user_id: authData.user.id,
      capability: "text",
      provider_key: provider.key,
      model_key: provider.model,
      attempt_number: failures.length + 1,
      status: "started",
      stage_key: "assistant_chat",
    }).select("id").single();
    if (attemptError) return json({ error: "RJ could not record provider attempt." }, 503);

    try {
      const reply = provider.key === "gemini"
        ? await callGemini(keys.get("gemini")!, clean)
        : provider.key === "groq_free"
          ? await callGroqFree(keys.get("groq")!, clean)
          : await callOpenRouter(keys.get("openrouter")!, clean);
      const now = new Date().toISOString();
      await admin.from("provider_health").upsert({
        user_id: authData.user.id, provider_key: provider.key, capability: "text",
        state: "available", cooldown_until: null, last_http_status: 200,
        last_error_code: null, updated_at: now,
      }, { onConflict: "user_id,provider_key,capability" });
      await admin.from("provider_attempts").update({
        status: "succeeded", http_status: 200, finished_at: now,
      }).eq("id", attempt.id);
      return json({ reply, provider: provider.label });
    } catch (error) {
      const failure = classifyProviderFailure(error);
      failures.push(provider.label + ": " + failure.message);
      const cooldown = cooldownUntil(failure, failures.length);
      const now = new Date().toISOString();
      await admin.from("provider_health").upsert({
        user_id: authData.user.id,
        provider_key: provider.key,
        capability: "text",
        state: cooldown ? "cooldown" : "needs_attention",
        cooldown_until: cooldown,
        last_http_status: failure.status,
        last_error_code: failure.code,
        updated_at: now,
      }, { onConflict: "user_id,provider_key,capability" });
      await admin.from("provider_attempts").update({
        status: failure.quota ? "quota_exhausted" : failure.status === 429 ? "rate_limited" : failure.retryable ? "failed" : "needs_attention",
        http_status: failure.status,
        error_code: failure.code,
        safe_error_message: failure.message,
        finished_at: now,
      }).eq("id", attempt.id);
      if (!failure.retryable) continue;
    }
  }
  console.error("RJ AI providers failed", failures);
  return json({ error: failures.join(" | ").slice(0, 700) || "All compatible connected providers are unavailable." }, 502);
});
