import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_MAP = Deno.env.get("SUPABASE_SECRET_KEYS");
const SECRET_KEY = SECRET_MAP ? (JSON.parse(SECRET_MAP) as Record<string,string>).default : "";
const ADMIN_KEY = SECRET_KEY || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_CLIENT_ID = Deno.env.get("YOUTUBE_OAUTH_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("YOUTUBE_OAUTH_CLIENT_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("RJ_YOUTUBE_TOKEN_ENCRYPTION_KEY") ?? "";
const CALLBACK_URL = SUPABASE_URL + "/functions/v1/rj-youtube-oauth";
const APP_RETURN_URL = "rj://youtube-connected";

if (!SUPABASE_URL || !ADMIN_KEY) throw new Error("Missing Supabase server credentials");
const admin = createClient(SUPABASE_URL, ADMIN_KEY, {
  global: { headers: SECRET_KEY ? { Authorization: "" } : {} },
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type":"application/json", "Cache-Control":"no-store" } });
}
function base64(bytes: Uint8Array) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function fromBase64(value: string) {
  const raw = atob(value.replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function encryptRefreshToken(token: string) {
  const rawKey = fromBase64(TOKEN_ENCRYPTION_KEY);
  if (rawKey.length !== 32) throw new Error("RJ_YOUTUBE_TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 random bytes");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, new TextEncoder().encode(token));
  return "v1:" + base64(iv) + ":" + base64(new Uint8Array(encrypted));
}
function randomToken(bytes = 32) { return base64(crypto.getRandomValues(new Uint8Array(bytes))); }

async function startOAuth(req: Request) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !TOKEN_ENCRYPTION_KEY) {
    return json({ error:"YouTube OAuth is not configured on the server yet." }, 503);
  }
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return json({ error:"Sign in to connect YouTube." }, 401);
  const { data, error } = await admin.auth.getUser(bearer);
  if (error || !data.user) return json({ error:"Your RJ session is invalid. Sign in again." }, 401);

  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = base64(await sha256(verifier));
  const stateHash = base64(await sha256(state));
  const { error: insertError } = await admin.from("youtube_oauth_states").insert({
    state_hash: stateHash, user_id: data.user.id, code_verifier: verifier,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (insertError) return json({ error:"Could not start secure YouTube connection." }, 500);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return json({ authorization_url:url.toString(), expires_in:600 });
}

async function finishOAuth(url: URL) {
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (error) return Response.redirect(APP_RETURN_URL + "?status=denied", 302);
  if (!code || !state) return Response.redirect(APP_RETURN_URL + "?status=invalid", 302);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !TOKEN_ENCRYPTION_KEY) {
    return Response.redirect(APP_RETURN_URL + "?status=not_configured", 302);
  }

  const stateHash = base64(await sha256(state));
  const { data: stateRow, error: stateError } = await admin.from("youtube_oauth_states")
    .select("user_id,code_verifier,expires_at,consumed_at")
    .eq("state_hash", stateHash).maybeSingle();
  if (stateError || !stateRow || stateRow.consumed_at || new Date(stateRow.expires_at).getTime() < Date.now()) {
    return Response.redirect(APP_RETURN_URL + "?status=expired", 302);
  }
  const { data: consumed, error: consumeError } = await admin.from("youtube_oauth_states")
    .update({ consumed_at:new Date().toISOString() })
    .eq("state_hash", stateHash).is("consumed_at", null).select("user_id,code_verifier").maybeSingle();
  if (consumeError || !consumed) return Response.redirect(APP_RETURN_URL + "?status=used", 302);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({
      code, client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET,
      redirect_uri:CALLBACK_URL, grant_type:"authorization_code",
      code_verifier:consumed.code_verifier,
    }),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.refresh_token || !tokens.access_token) {
    console.error("YouTube token exchange failed", tokenResponse.status, tokens.error);
    return Response.redirect(APP_RETURN_URL + "?status=token_failed", 302);
  }

  const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet%2Cid&mine=true", {
    headers:{ Authorization:"Bearer " + tokens.access_token },
  });
  const channelBody = await channelResponse.json().catch(() => ({}));
  const channel = channelBody?.items?.[0];
  if (!channel?.id) {
    console.error("YouTube channel lookup failed", channelResponse.status);
    return Response.redirect(APP_RETURN_URL + "?status=no_channel", 302);
  }
  const encrypted = await encryptRefreshToken(tokens.refresh_token);
  const { error: saveError } = await admin.from("youtube_channels").upsert({
    user_id:consumed.user_id,
    channel_id:String(channel.id),
    channel_title:String(channel.snippet?.title ?? "YouTube channel"),
    channel_handle:channel.snippet?.customUrl ?? null,
    encrypted_refresh_token:encrypted,
    token_key_version:1,
    granted_scopes:String(tokens.scope ?? "").split(" ").filter(Boolean),
    timezone:"Asia/Colombo",
    is_active:true,
    updated_at:new Date().toISOString(),
  }, { onConflict:"user_id,channel_id" });
  if (saveError) {
    console.error("YouTube channel save failed", saveError.message);
    return Response.redirect(APP_RETURN_URL + "?status=save_failed", 302);
  }
  return Response.redirect(APP_RETURN_URL + "?status=connected", 302);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) return await finishOAuth(url);
  if (req.method !== "POST") return json({ error:"Use POST to begin YouTube connection." }, 405);
  return await startOAuth(req);
});
