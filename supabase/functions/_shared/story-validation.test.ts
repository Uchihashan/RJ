import {
  buildStoryPrompt,
  buildStoryRepairPrompt,
  requestedDurationMinutes,
  validateStoryAgainstTopic,
} from "./story-validation.ts";

Deno.test("prompt keeps the exact Tamil project topic and requested two-minute duration", () => {
  const topic = "ஒரு குட்டி முயலும் சிங்கமும் நண்பர்களான கதை. 2 நிமிட குழந்தைகள் கதை.";
  const prompt = buildStoryPrompt(topic, "Tamil");
  if (!prompt.includes(topic)) throw new Error("Exact topic was not included");
  if (!prompt.includes("Target narration length: about 2 minute(s)")) throw new Error("Requested duration was ignored");
  if (!prompt.includes("rabbit / முயல்") || !prompt.includes("lion / சிங்கம்")) throw new Error("Required protagonists missing from prompt");
  if (prompt.includes("4–6 minute")) throw new Error("Old fixed duration instruction remains");
});

Deno.test("topic validator rejects an unrelated Banu and butterfly story", () => {
  const topic = "ஒரு குட்டி முயலும் சிங்கமும் நண்பர்களான கதை";
  const story = "தலைப்பு: பாட்டுப் பாடும் பானுவும் வண்ணத்துப்பூச்சிகளும். பானு தோட்டத்தில் விளையாடினாள்.";
  const result = validateStoryAgainstTopic(topic, story);
  if (result.ok) throw new Error("Unrelated story was incorrectly accepted");
  if (result.missingAnchors.length !== 2) throw new Error("Expected both requested animal anchors to be missing");
});

Deno.test("topic validator accepts a story containing both requested protagonists", () => {
  const topic = "ஒரு குட்டி முயலும் சிங்கமும் நண்பர்களான கதை";
  const story = "மொப்பு என்ற முயல் குட்டியும் குகன் என்ற சிங்கக் குட்டியும் நண்பர்களானார்கள்.";
  const result = validateStoryAgainstTopic(topic, story);
  if (!result.ok) throw new Error("Relevant story was rejected");
});

Deno.test("explicit character names must be retained", () => {
  const topic = "**மொப்பு** - வெண்மையான முயல். **குகன்** - சிங்கக் குட்டி.";
  const result = validateStoryAgainstTopic(topic, "மொப்பு என்ற முயலும் குகன் என்ற சிங்கமும் நண்பர்கள்.");
  if (!result.ok) throw new Error("Correct named characters were rejected: " + JSON.stringify(result));
  const missing = validateStoryAgainstTopic(topic, "பானு என்ற குழந்தை தோட்டத்தில் விளையாடினாள்.");
  if (missing.ok) throw new Error("Story with missing named characters was accepted");
});

Deno.test("duration parser defaults safely and clamps unreasonable values", () => {
  if (requestedDurationMinutes("ஒரு முயல் கதை") !== 3) throw new Error("Default duration should be three minutes");
  if (requestedDurationMinutes("120 minutes") !== 15) throw new Error("Duration should be capped at fifteen minutes");
  if (requestedDurationMinutes("2 நிமிட கதை") !== 2) throw new Error("Tamil duration was not parsed");
});

Deno.test("repair prompt lists the missing project anchors", () => {
  const repair = buildStoryRepairPrompt("PROJECT_TOPIC: rabbit and lion", ["rabbit / முயல்", "lion / சிங்கம்"]);
  if (!repair.includes("rabbit / முயல்") || !repair.includes("lion / சிங்கம்")) throw new Error("Repair prompt omitted missing anchors");
});
