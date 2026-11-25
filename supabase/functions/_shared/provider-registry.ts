export type ProviderCapability =
  | "text" | "image" | "video" | "speech" | "transcription" | "captions"
  | "media_assembly" | "render" | "storage" | "youtube_upload"
  | "youtube_schedule" | "media_analysis";

export type PricingMode = "free_route" | "free_tier" | "account_dependent" | "paid";

export type ProviderSpec = {
  key: string;
  label: string;
  capability: ProviderCapability;
  model: string;
  pricingMode: PricingMode;
  outputFormats: readonly string[];
  credentialKey: string;
  enabled: boolean;
};

export type ProviderHealth = {
  provider_key: string;
  state: "available" | "cooldown" | "needs_attention" | "disabled";
  cooldown_until: string | null;
};

export type ProviderPolicy = {
  allow_paid_providers: boolean;
  monthly_budget_usd: number;
};

export const CAPABILITY_REQUIREMENTS: Record<string, ProviderCapability> = {
  script_storyboard: "text",
  scene_assets: "image",
  voice_audio: "speech",
  captions: "transcription",
  timeline_edit: "media_assembly",
  render_export: "render",
  quality_check: "media_analysis",
  metadata_thumbnail: "text",
  youtube_upload: "youtube_upload",
  youtube_schedule_verify: "youtube_schedule",
};

export const PROVIDER_CATALOG: readonly ProviderSpec[] = [
  {
    key: "openrouter",
    label: "OpenRouter Free Router",
    capability: "text",
    model: "openrouter/free",
    pricingMode: "free_route",
    outputFormats: ["text"],
    credentialKey: "openrouter",
    enabled: true,
  },
  {
    key: "groq_free",
    label: "Groq Free Tier",
    capability: "text",
    model: "openai/gpt-oss-20b",
    pricingMode: "free_tier",
    outputFormats: ["text"],
    credentialKey: "groq",
    // Use only an API key belonging to a Groq Free-tier organization.
    // Never upgrade that organization to Developer/PayGo; RJ never performs upgrades.
    enabled: true,
  },
  {
    key: "gemini",
    label: "Google Gemini",
    capability: "text",
    model: "gemini-3.5-flash-lite",
    pricingMode: "account_dependent",
    outputFormats: ["text"],
    credentialKey: "gemini",
    // Disabled until RJ can measure and enforce a hard per-user spend limit.
    enabled: false,
  },
  {
    key: "gemini_tts",
    label: "Google Gemini 3.8 Flash TTS",
    capability: "speech",
    model: "gemini-3.8-flash-tts",
    pricingMode: "account_dependent",
    outputFormats: ["audio/wav"],
    credentialKey: "gemini",
    // Google lists a free tier, but API projects can be on a billable tier.
    // Keep disabled until RJ can enforce project-tier and per-request spend controls.
    enabled: false,
  },
  {
    key: "cloudflare_flux_schnell",
    label: "Cloudflare Workers AI Free",
    capability: "image",
    model: "@cf/black-forest-labs/flux-1-schnell",
    pricingMode: "free_tier",
    outputFormats: ["image/jpeg"],
    credentialKey: "cloudflare",
    // Use only a Cloudflare Workers Free account. Its daily free allocation hard-stops at quota.
    enabled: true,
  },
  {
    key: "gemini_image",
    label: "Google Gemini Flash Lite Image",
    capability: "image",
    model: "gemini-3.1-flash-lite-image",
    pricingMode: "paid",
    outputFormats: ["image/png", "image/jpeg"],
    credentialKey: "gemini",
    // Official pricing currently lists no free tier for image generation.
    enabled: false,
  },
  {
    key: "gemini_video",
    label: "Google Gemini Omni Flash Video",
    capability: "video",
    model: "gemini-omni-1.1-flash",
    pricingMode: "paid",
    outputFormats: ["video/mp4"],
    credentialKey: "gemini",
    // Official pricing currently lists this model on the paid tier only.
    enabled: false,
  },
];

export type RoutingPolicy = {
  allowPaidProviders: boolean;
  monthlyBudgetUsd: number;
};

export function selectEligibleProviders(
  capability: ProviderCapability,
  connectedKeys: ReadonlyMap<string, string>,
  healthRows: readonly ProviderHealth[],
  policy: RoutingPolicy,
  nowMs = Date.now(),
): ProviderSpec[] {
  const health = new Map(healthRows.map((row) => [row.provider_key, row]));
  return PROVIDER_CATALOG
    .filter((provider) => provider.enabled && provider.capability === capability)
    .filter((provider) => connectedKeys.has(provider.credentialKey))
    .filter((provider) => provider.pricingMode === "free_route" || provider.pricingMode === "free_tier"
      || (policy.allowPaidProviders && policy.monthlyBudgetUsd > 0))
    .filter((provider) => {
      const state = health.get(provider.key);
      if (!state || state.state === "available") return true;
      if (state.state !== "cooldown") return false;
      return !state.cooldown_until || new Date(state.cooldown_until).getTime() <= nowMs;
    })
    .sort((a, b) => {
      const rank = (p: ProviderSpec) => p.pricingMode === "free_route" || p.pricingMode === "free_tier" ? 0 : 1;
      return rank(a) - rank(b);
    });
}

export function classifyProviderFailure(error: unknown): {
  status: number | null;
  quota: boolean;
  retryable: boolean;
  code: string;
  message: string;
} {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : null;
  const message = error instanceof Error ? error.message : "Provider request failed";
  const quota = status === 429 || /quota|resource exhausted|rate.?limit/i.test(message);
  const invalidAuth = status === 401 || status === 403;
  const invalidInput = status === 400 || status === 404 || status === 422;
  return {
    status: Number.isFinite(status) ? status : null,
    quota,
    retryable: quota || (!invalidAuth && !invalidInput && (status === null || status >= 500)),
    code: quota ? "quota_exhausted" : invalidAuth ? "invalid_credentials_or_access"
      : invalidInput ? "unsupported_request" : status === null ? "network_error" : "http_" + status,
    message: message.slice(0, 500),
  };
}

export function cooldownUntil(
  failure: ReturnType<typeof classifyProviderFailure>,
  attemptNumber: number,
  nowMs = Date.now(),
): string | null {
  if (!failure.retryable) return null;
  const baseMs = failure.quota ? 30 * 60_000 : 5 * 60_000;
  const delayMs = Math.min(6 * 60 * 60_000, baseMs * Math.pow(2, Math.max(0, attemptNumber - 1)));
  return new Date(nowMs + delayMs).toISOString();
}
