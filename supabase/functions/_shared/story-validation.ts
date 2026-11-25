export type StoryTopicValidation = {
  ok: boolean;
  requiredAnchors: string[];
  missingAnchors: string[];
};

const SUBJECT_ANCHORS: Array<{ label: string; topic: RegExp; story: RegExp }> = [
  { label: "rabbit / முயல்", topic: /முயல|rabbit/i, story: /முயல|rabbit/i },
  { label: "lion / சிங்கம்", topic: /சிங்க|lion/i, story: /சிங்க|lion/i },
  { label: "elephant / யானை", topic: /யான|elephant/i, story: /யான|elephant/i },
  { label: "butterfly / வண்ணத்துப்பூச்சி", topic: /வண்ணத்துப்பூச்ச|butterfl/i, story: /வண்ணத்துப்பூச்ச|butterfl/i },
  { label: "turtle / ஆமை", topic: /ஆமை|turtle/i, story: /ஆமை|turtle/i },
  { label: "dog / நாய்", topic: /நாய|நாய்|dog/i, story: /நாய|நாய்|dog/i },
  { label: "cat / பூனை", topic: /பூனை|பூன|cat/i, story: /பூனை|பூன|cat/i },
  { label: "bird / பறவை", topic: /பறவை|பறவ|bird/i, story: /பறவை|பறவ|bird/i },
];

function extractNamedCharacters(topic: string): string[] {
  const names = new Set<string>();
  for (const match of topic.matchAll(/\*\*([^*]{2,30})\*\*/gu)) {
    const value = match[1].trim();
    if (value) names.add(value);
  }
  for (const match of topic.matchAll(/(?:பெயர்|name|called)\s*[:：-]\s*([\p{L}]{2,30})/giu)) {
    const value = match[1].trim();
    if (value) names.add(value);
  }
  return [...names];
}

export function requestedDurationMinutes(topic: string): number {
  const match = topic.match(/(\d{1,2})\s*(?:நிமிட(?:ம்|ங்கள்)?|minutes?|mins?)/iu);
  if (!match) return 3;
  return Math.min(15, Math.max(1, Number(match[1])));
}

export function buildStoryPrompt(topic: string, language: string): string {
  const duration = requestedDurationMinutes(topic);
  const subjects = SUBJECT_ANCHORS.filter((item) => item.topic.test(topic)).map((item) => item.label);
  const namedCharacters = extractNamedCharacters(topic);
  return `Create one original, age-appropriate children's story for a YouTube video.
THIS PROJECT'S EXACT TOPIC (binding brief; do not replace it):
<PROJECT_TOPIC>
${topic}
</PROJECT_TOPIC>
Language: ${language}
Target narration length: about ${duration} minute(s) (roughly ${duration * 90}-${duration * 120} spoken words).
${subjects.length ? `Required story subjects that MUST appear: ${subjects.join(", ")}.` : ""}
${namedCharacters.length ? `Required character names that MUST be preserved exactly: ${namedCharacters.join(", ")}.` : ""}
NON-NEGOTIABLE RULES:
- Build the story only from the exact project topic above. Do not use a sample story, previous project, chat history, or any other topic.
- Keep the requested main characters, animals, relationship, and story premise. Do not substitute a child, toy, butterfly, or unrelated character for the requested protagonists.
- If the topic gives character names, spell and use those same names throughout.
- Do not invent a different title or unrelated story premise.
- Write in natural ${language}; keep names and sentences easy for children.
- Start with an engaging title and a short hook.
- Divide the story into 5–6 clearly numbered scenes suitable for the requested duration.
- For every scene provide: visual description, narrator voice-over, and any short dialogue.
- Finish with a gentle positive moral and a short closing line.
- Keep it kind, safe, non-frightening, and suitable for children.
- Do not use copyrighted characters, existing story plots, or song lyrics.
Return only the complete story script as readable text.`;
}

export function validateStoryAgainstTopic(topic: string, story: string): StoryTopicValidation {
  const required = SUBJECT_ANCHORS.filter((item) => item.topic.test(topic));
  const namedCharacters = extractNamedCharacters(topic);
  const requiredAnchors = [
    ...required.map((item) => item.label),
    ...namedCharacters,
  ];
  const missingAnchors = [
    ...required.filter((item) => !item.story.test(story)).map((item) => item.label),
    ...namedCharacters.filter((name) => !story.toLocaleLowerCase().includes(name.toLocaleLowerCase())),
  ];
  return {
    ok: missingAnchors.length === 0,
    requiredAnchors,
    missingAnchors,
  };
}

export function buildStoryRepairPrompt(originalPrompt: string, missingAnchors: string[]): string {
  return `${originalPrompt}

REWRITE REQUIRED: Your previous draft was rejected because it did not follow the project topic.
The revised story MUST explicitly include these missing subjects/names: ${missingAnchors.join(", ")}.
Discard the unrelated draft completely. Write a fresh story that follows the PROJECT_TOPIC exactly.`;
}
