import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSceneSvg,
  buildSrt,
  escapeXml,
  formatSrtTime,
  sceneDurationSeconds,
  splitStoryIntoScenes,
  wrapText,
} from "./pipeline.js";

test("parses numbered English scenes and removes speaker labels", () => {
  const scenes = splitStoryIntoScenes("Title: River\nScene 1: The Start\nNarrator: A small bird flew over the river.\n\nScene 2: The End\nDialogue: We can help each other.");
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0]?.title, "The Start");
  assert.match(scenes[0]?.text ?? "", /small bird/);
  assert.doesNotMatch(scenes[0]?.text ?? "", /Narrator:/);
});

test("falls back to paragraph chunking for Tamil story text", () => {
  const scenes = splitStoryIntoScenes("ஒரு சிறிய கிராமத்தில் ஒரு சிறுவன் வாழ்ந்தான்.\n\nஒருநாள் அவன் நண்பர்களுக்கு உதவினான்.\n\nஅனைவரும் மகிழ்ந்தனர்.");
  assert.equal(scenes.length, 3);
  assert.match(scenes[0]?.text ?? "", /கிராமத்தில்/);
});

test("escapes XML special characters before SVG insertion", () => {
  assert.equal(escapeXml(`A & B <C> "D"`), "A &amp; B &lt;C&gt; &quot;D&quot;");
  assert.match(buildSceneSvg({ title: "<unsafe>", topic: "Topic", body: "A & B", index: 0, total: 1 }), /&lt;unsafe&gt;/);
});

test("wraps long text without exceeding configured line count", () => {
  const lines = wrapText("one two three four five six seven eight nine ten", 10, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => Array.from(line).length <= 11));
});

test("subtitle times are valid SRT timestamps", () => {
  assert.equal(formatSrtTime(65.125), "00:01:05,125");
  const srt = buildSrt([{ title: "Scene", text: "Tamil caption" }]);
  assert.match(srt, /00:00:00,000 --> 00:00:06,000/);
  assert.match(srt, /Tamil caption/);
});

test("scene duration is bounded for long narration", () => {
  assert.equal(sceneDurationSeconds({ title: "Short", text: "hello" }), 6);
  assert.equal(sceneDurationSeconds({ title: "Long", text: "word ".repeat(100) }), 14);
});