export type StoryScene = {
  title: string;
  text: string;
};

const MAX_STORY_CHARS = 18_000;
const MAX_SCENES = 12;
const MAX_SCENE_CHARS = 900;

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cleanLine(value: string): string {
  return value
    .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitParagraphs(value: string): string[] {
  return value
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map(cleanLine)
    .filter(Boolean);
}

export function splitStoryIntoScenes(story: string): StoryScene[] {
  const source = story.trim().slice(0, MAX_STORY_CHARS);
  if (!source) throw new Error("The generated story is empty");

  const heading = /^\s*(?:#{1,3}\s*)?(?:scene|காட்சி)\s*0*(\d+)\s*[:.)\-–—]?\s*(.*)$/i;
  const lines = source.split(/\r?\n/);
  const groups: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(heading);
    if (match) {
      if (current) groups.push(current);
      current = { title: cleanLine(match[2] || `Scene ${match[1]}`), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) groups.push(current);

  let scenes: StoryScene[];
  if (groups.length >= 2) {
    scenes = groups.map((group, index) => ({
      title: group.title || `Scene ${index + 1}`,
      text: group.lines
        .map((line) => line.replace(/^\s*(?:visual(?:\s+description)?|narrator(?:\s+voice[- ]over)?|voice[- ]over|dialogue|குரல்|உரையாடல்)\s*:\s*/i, ""))
        .map(cleanLine)
        .filter(Boolean)
        .join(" ")
        .slice(0, MAX_SCENE_CHARS),
    })).filter((scene) => scene.text);
  } else {
    const paragraphs = splitParagraphs(source);
    const chunkCount = Math.min(MAX_SCENES, Math.max(1, Math.min(8, paragraphs.length)));
    const chunks: string[] = Array.from({ length: chunkCount }, () => "");
    paragraphs.forEach((paragraph, index) => {
      const slot = Math.min(chunkCount - 1, Math.floor(index * chunkCount / Math.max(1, paragraphs.length)));
      chunks[slot] = [chunks[slot], paragraph].filter(Boolean).join(" ");
    });
    scenes = chunks.filter(Boolean).map((text, index) => ({
      title: `Scene ${index + 1}`,
      text: text.slice(0, MAX_SCENE_CHARS),
    }));
  }

  if (!scenes.length) {
    scenes = [{ title: "Story", text: source.slice(0, MAX_SCENE_CHARS) }];
  }
  return scenes.slice(0, MAX_SCENES);
}

export function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const parts = Array.from(word);
    if (parts.length > maxChars) {
      if (line) { lines.push(line); line = ""; }
      for (let i = 0; i < parts.length; i += maxChars) {
        if (lines.length >= maxLines) break;
        lines.push(parts.slice(i, i + maxChars).join(""));
      }
      continue;
    }
    const candidate = line ? line + " " + word : word;
    if (Array.from(candidate).length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.length === maxLines) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = last.replace(/[.…]*$/, "…");
  }
  return lines;
}

export function sceneDurationSeconds(scene: StoryScene): number {
  const words = scene.text.split(/\s+/).filter(Boolean).length;
  return Math.max(6, Math.min(14, Math.ceil(words / 2.5)));
}

export function formatSrtTime(totalSeconds: number): string {
  const milliseconds = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildSrt(scenes: StoryScene[]): string {
  let cursor = 0;
  return scenes.map((scene, index) => {
    const duration = sceneDurationSeconds(scene);
    const entry = `${index + 1}\n${formatSrtTime(cursor)} --> ${formatSrtTime(cursor + duration)}\n${scene.text}\n`;
    cursor += duration;
    return entry;
  }).join("\n");
}

export function buildSceneSvg(input: {
  title: string;
  topic: string;
  body: string;
  index: number;
  total: number;
}): string {
  const titleLines = wrapText(input.title || `Scene ${input.index + 1}`, 30, 2);
  const bodyLines = wrapText(input.body, 46, 6);
  const titleSvg = titleLines.map((line, index) =>
    `<text x="92" y="${190 + index * 62}" class="title">${escapeXml(line)}</text>`
  ).join("");
  const bodyStart = 370 + Math.max(0, titleLines.length - 1) * 42;
  const bodySvg = bodyLines.map((line, index) =>
    `<text x="96" y="${bodyStart + index * 49}" class="body">${escapeXml(line)}</text>`
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#101827"/>
        <stop offset="1" stop-color="#243b53"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#f97316"/>
        <stop offset="1" stop-color="#facc15"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#bg)"/>
    <circle cx="1120" cy="110" r="210" fill="#ffffff" opacity=".035"/>
    <circle cx="120" cy="690" r="260" fill="#ffffff" opacity=".025"/>
    <rect x="92" y="90" width="8" height="520" rx="4" fill="url(#accent)"/>
    <text x="128" y="116" class="eyebrow">${escapeXml(input.topic.slice(0, 80))}</text>
    ${titleSvg}
    <rect x="96" y="${bodyStart - 45}" width="96" height="5" rx="2" fill="url(#accent)"/>
    ${bodySvg}
    <text x="96" y="660" class="footer">RJ STORY STUDIO</text>
    <text x="1184" y="660" text-anchor="end" class="footer">${input.index + 1} / ${input.total}</text>
    <style>
      text { font-family: "Noto Sans Tamil", "Noto Sans", sans-serif; }
      .eyebrow { fill: #facc15; font-size: 21px; letter-spacing: 2px; }
      .title { fill: #ffffff; font-size: 48px; font-weight: 700; }
      .body { fill: #e5edf5; font-size: 30px; }
      .footer { fill: #aab8c7; font-size: 17px; letter-spacing: 3px; }
    </style>
  </svg>`;
}
