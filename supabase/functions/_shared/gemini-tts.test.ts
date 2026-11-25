import { extractGeminiTtsAudio } from "./gemini-tts.ts";

Deno.test("extracts the final audio block from Gemini Interactions response", () => {
  const result = extractGeminiTtsAudio({
    steps: [
      { type: "model_output", content: [{ type: "text", text: "ignored" }] },
      { type: "model_output", content: [
        { type: "audio", data: "UklGRg==" },
        { type: "audio", data: "UklGRlZBVkU=" },
      ] },
    ],
  });
  if (result !== "UklGRlZBVkU=") throw new Error("Expected final audio block");
});

Deno.test("accepts SDK-style output_audio convenience shape", () => {
  const result = extractGeminiTtsAudio({ output_audio: { data: "UklGRg==" } });
  if (result !== "UklGRg==") throw new Error("Expected output_audio data");
});

Deno.test("rejects responses without audio", () => {
  let rejected = false;
  try {
    extractGeminiTtsAudio({ steps: [{ type: "model_output", content: [{ type: "text", text: "no audio" }] }] });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Missing audio must be rejected");
});
