import { assertEquals } from "jsr:@std/assert@1";
import { parseAgentOutput } from "./agent-response.ts";

const context = { rendered_projects: [{ id: "49e50bf8-e0bb-4ebd-a3bf-4e2e83af9f0d", topic: "Tamil kids story" }] };

Deno.test("parses a safe video creation intent", () => {
  const result = parseAgentOutput(JSON.stringify({ reply: "இந்த video project-ஐ queue-ல் சேர்க்கலாமா?", action: { tool: "video.create", arguments: { topic: "பாட்டுப் பாடும் பானு" } } }), context);
  assertEquals(result.action?.tool, "video.create");
  assertEquals(result.action?.arguments.topic, "பாட்டுப் பாடும் பானு");
});

Deno.test("accepts YouTube upload only for a rendered project in context", () => {
  const valid = parseAgentOutput(JSON.stringify({ reply: "இந்த video-வை PRIVATE-ஆக upload செய்யலாமா?", action: { tool: "youtube.upload", arguments: { job_id: context.rendered_projects[0].id } } }), context);
  assertEquals(valid.action?.tool, "youtube.upload");
  const invented = parseAgentOutput(JSON.stringify({ reply: "Upload செய்யலாமா?", action: { tool: "youtube.upload", arguments: { job_id: "00000000-0000-4000-8000-000000000000" } } }), context);
  assertEquals(invented.action, null);
});

Deno.test("rejects invalid reminder time and unsupported navigation tab", () => {
  const reminder = parseAgentOutput(JSON.stringify({ reply: "நினைவூட்டலை அமைக்கலாமா?", action: { tool: "reminder.create", arguments: { title: "Study", time: "29:90" } } }), context);
  assertEquals(reminder.action, null);
  const navigation = parseAgentOutput(JSON.stringify({ reply: "அந்த screen-ஐ திறக்கலாமா?", action: { tool: "navigation.open", arguments: { tab: "Admin" } } }), context);
  assertEquals(navigation.action, null);
});

Deno.test("falls back to ordinary chat for non-JSON model output", () => {
  const result = parseAgentOutput("வணக்கம்! என்ன உதவி வேண்டும்?", context);
  assertEquals(result.reply, "வணக்கம்! என்ன உதவி வேண்டும்?");
  assertEquals(result.action, null);
});
