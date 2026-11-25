export type GeminiTtsOptions = {
  apiKey: string;
  text: string;
  voice?: string;
  style?: string;
  signal?: AbortSignal;
};

export type GeminiTtsAudio = {
  bytes: Uint8Array;
  mimeType: "audio/wav";
};

export function extractGeminiTtsAudio(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new Error("Gemini TTS returned an invalid response");
  }
  const root = body as {
    output_audio?: { data?: unknown };
    steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: unknown }> }>;
  };
  if (typeof root.output_audio?.data === "string" && root.output_audio.data.length > 0) {
    return root.output_audio.data;
  }
  const audio = (root.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === "audio" && typeof part.data === "string")
    .map((part) => part.data as string)
    .filter(Boolean)
    .at(-1);
  if (!audio) throw new Error("Gemini TTS returned no audio data");
  return audio;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Google Gemini 3.8 Flash TTS adapter.
 * This adapter is intentionally not wired into job execution while account-tier
 * billing cannot be verified and hard spend enforcement is not available.
 */
export async function callGeminiTts(options: GeminiTtsOptions): Promise<GeminiTtsAudio> {
  const text = options.text.trim();
  if (!options.apiKey.trim()) throw new Error("Gemini TTS API key is missing");
  if (!text || text.length > 12000) {
    throw new Error("Gemini TTS text must be between 1 and 12000 characters");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash-tts",
        input: [{
          type: "user_input",
          content: [{
            type: "text",
            text,
            annotations: [{
              type: "speech_metadata",
              style: (options.style ?? "warm, friendly children's story narrator").slice(0, 240),
            }],
          }],
        }],
        response_format: { type: "audio" },
        generation_config: {
          speech_config: [{ voice: options.voice ?? "Kore" }],
        },
        store: false,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = (body as { error?: { message?: string } })?.error?.message
        ?? "Gemini TTS request failed";
      throw Object.assign(new Error(String(detail).slice(0, 500)), { status: response.status });
    }
    const base64 = extractGeminiTtsAudio(body);
    const bytes = decodeBase64(base64);
    if (bytes.length < 44) throw new Error("Gemini TTS returned an incomplete WAV file");
    // Gemini 3.8 unary TTS returns a complete 24 kHz mono WAV container.
    if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF"
      || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") {
      throw new Error("Gemini TTS response was not a valid WAV file");
    }
    return { bytes, mimeType: "audio/wav" };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
