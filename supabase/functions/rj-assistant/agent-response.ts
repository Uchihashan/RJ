export type AgentContext = { rendered_projects: Array<{ id: string; topic: string }> };

export function agentSystemPrompt(context: AgentContext): string {
  return [
    "You are RJ, a helpful personal AI agent inside an Android app.",
    "Understand and respond naturally in Tamil script, Tanglish, or English. Reply in the user's language.",
    "Return ONLY one valid JSON object: {\"reply\": string, \"action\": null | {\"tool\": string, \"arguments\": object}}. No markdown fences.",
    "Allowed tools: video.create {topic}; reminder.create {title,time} where time is 24-hour HH:MM; navigation.open {tab} from Home, Create, Edit, Tools, Schedule, Settings; youtube.upload {job_id}.",
    "Propose an action only when the latest user message clearly asks RJ to perform it. Questions, explanations, brainstorming, and vague requests must have action:null.",
    "Never invent a YouTube job ID. youtube.upload may use only an exact id in the rendered-project list below.",
    "Do not perform actions yourself. The app shows a confirmation card and the user must confirm before anything runs.",
    "For video.create, require a clear topic. If missing, ask the user and return action:null.",
    "Never ask for passwords or one-time codes. Never claim an action succeeded before the app reports it.",
    "Rendered projects available for an explicitly requested YouTube upload: " + JSON.stringify(context.rendered_projects),
  ].join("\n");
}

export function parseAgentOutput(raw: string, context: AgentContext): { reply: string; action: { tool: string; arguments: Record<string, string> } | null } {
  const cleaned = raw.trim().replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { reply: raw.trim(), action: null };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const reply = typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : raw.trim();
    const proposed = parsed?.action;
    if (!proposed || typeof proposed !== "object" || typeof proposed.tool !== "string") return { reply, action: null };
    const input = proposed.arguments && typeof proposed.arguments === "object" ? proposed.arguments : {};
    let action: { tool: string; arguments: Record<string, string> } | null = null;
    if (proposed.tool === "video.create" && typeof input.topic === "string" && input.topic.trim()) action = { tool: "video.create", arguments: { topic: input.topic.trim().slice(0, 180) } };
    else if (proposed.tool === "reminder.create" && typeof input.title === "string" && input.title.trim() && typeof input.time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) action = { tool: "reminder.create", arguments: { title: input.title.trim().slice(0, 120), time: input.time } };
    else if (proposed.tool === "navigation.open" && typeof input.tab === "string" && ["Home", "Create", "Edit", "Tools", "Schedule", "Settings"].includes(input.tab)) action = { tool: "navigation.open", arguments: { tab: input.tab } };
    else if (proposed.tool === "youtube.upload" && typeof input.job_id === "string" && context.rendered_projects.some(project => project.id === input.job_id)) action = { tool: "youtube.upload", arguments: { job_id: input.job_id } };
    return { reply, action };
  } catch {
    return { reply: raw.trim(), action: null };
  }
}
