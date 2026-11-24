import { createClient } from "npm:@supabase/supabase-js@2";

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

async function callGemini(apiKey: string, messages: ChatMessage[]) {
  const prompt = [
    "You are RJ, a helpful personal AI agent inside an Android app.",
    "Understand and respond naturally in Tamil script, Tanglish, or English. Reply in the user's language.",
    "Be practical, concise, and honest. You may explain plans and draft actions, but do not claim to have performed external actions.",
    "Never ask for passwords or one-time codes. Ask for confirmation before any paid, publishing, destructive, or external side-effect action.",
    "For video requests, help create an editable plan/script; do not claim a rendered video exists.",
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

async function callOpenRouter(apiKey: string, messages: ChatMessage[]) {
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
  const keys = new Map<string, string>((rows ?? []).map((r: { provider: string; api_key: string }) => [r.provider, r.api_key]));
  const failures: string[] = [];
  const gemini = keys.get("gemini");
  const openrouter = keys.get("openrouter");

  if (gemini) {
    try { return json({ reply: await callGemini(gemini, clean), provider: "Gemini" }); }
    catch (error) { failures.push("Gemini: " + (error instanceof Error ? error.message : "request failed")); }
  }
  if (openrouter) {
    try { return json({ reply: await callOpenRouter(openrouter, clean), provider: "OpenRouter" }); }
    catch (error) { failures.push("OpenRouter: " + (error instanceof Error ? error.message : "request failed")); }
  }
  if (!gemini && !openrouter) {
    return json({ error: "AI provider not connected. Open Tools → Settings and connect Gemini or OpenRouter first." }, 424);
  }
  console.error("RJ AI providers failed", failures);
  return json({ error: failures.join(" | ").slice(0, 700) || "All connected AI providers are unavailable." }, 502);
});
