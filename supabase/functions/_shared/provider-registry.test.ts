import {
  classifyProviderFailure,
  selectEligibleProviders,
  type ProviderHealth,
} from "./provider-registry.ts";

Deno.test("free-only routing excludes account-dependent Gemini", () => {
  const keys = new Map([["gemini", "secret"], ["openrouter", "secret"]]);
  const selected = selectEligibleProviders("text", keys, [], {
    allowPaidProviders: false,
    monthlyBudgetUsd: 0,
  });
  if (selected.length !== 1 || selected[0].key !== "openrouter") {
    throw new Error("Free-only policy must select only the free route");
  }
});

Deno.test("paid routing still prefers compatible free providers", () => {
  const keys = new Map([["gemini", "secret"], ["openrouter", "secret"]]);
  const selected = selectEligibleProviders("text", keys, [], {
    allowPaidProviders: true,
    monthlyBudgetUsd: 5,
  });
  if (selected.length !== 1 || selected[0].key !== "openrouter") {
    throw new Error("Account-dependent providers stay disabled until spend enforcement is implemented");
  }
});

Deno.test("capability mismatch never routes a text key to video", () => {
  const keys = new Map([["gemini", "secret"], ["openrouter", "secret"]]);
  const selected = selectEligibleProviders("video", keys, [], {
    allowPaidProviders: true,
    monthlyBudgetUsd: 10,
  });
  if (selected.length !== 0) throw new Error("Text providers must not be selected for video");
});

Deno.test("cooldown filters only the provider that is cooling down", () => {
  const keys = new Map([["gemini", "secret"], ["openrouter", "secret"]]);
  const health: ProviderHealth[] = [{
    provider_key: "openrouter",
    state: "cooldown",
    cooldown_until: new Date(2_000).toISOString(),
  }];
  const selected = selectEligibleProviders("text", keys, health, {
    allowPaidProviders: false,
    monthlyBudgetUsd: 0,
  }, 1_000);
  if (selected.length !== 0) throw new Error("No free compatible provider should be selected during cooldown");
});

Deno.test("quota errors are retryable and classified", () => {
  const result = classifyProviderFailure(Object.assign(new Error("resource exhausted"), { status: 429 }));
  if (!result.quota || !result.retryable || result.code !== "quota_exhausted") {
    throw new Error("429 quota failure should be retryable");
  }
});

Deno.test("invalid credentials do not trigger blind retries", () => {
  const result = classifyProviderFailure(Object.assign(new Error("unauthorized"), { status: 401 }));
  if (result.retryable || result.code !== "invalid_credentials_or_access") {
    throw new Error("401 must require attention, not cooldown retry");
  }
});

Deno.test("speech adapter remains disabled until spend enforcement exists", () => {
  const keys = new Map([["gemini", "secret"]]);
  const selected = selectEligibleProviders("speech", keys, [], {
    allowPaidProviders: true,
    monthlyBudgetUsd: 100,
  });
  if (selected.length !== 0) {
    throw new Error("Gemini TTS must not execute while account billing cannot be enforced");
  }
});
