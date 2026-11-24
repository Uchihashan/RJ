import React, { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

type Project = { id: string; topic: string; language: string; createdAt: string; status: string; story?: string };
type Props = { projects: Project[]; onSave: (id: string, topic: string, story: string, description: string, ratio: string, captions: boolean) => void };

const RED = "#F3263D";

export default function VideoEditorScreen({ projects, onSave }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [description, setDescription] = useState("");
  const [ratio, setRatio] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [captions, setCaptions] = useState(true);

  useEffect(() => {
    const current = projects.find(p => p.id === selectedId) ?? projects[0];
    if (!current) {
      setSelectedId("");
      setTitle("");
      setScript("");
      return;
    }
    setSelectedId(current.id);
    setTitle(current.topic);
    setScript(current.story ?? "");
    setDescription(current.topic + " | " + current.language);
  }, [projects, selectedId]);

  const choose = (project: Project) => {
    setSelectedId(project.id);
    setTitle(project.topic);
    setScript(project.story ?? "");
    setDescription(project.topic + " | " + project.language);
  };

  const save = () => {
    if (!selectedId) {
      Alert.alert("Project needed", "Create a video project first in the Create tab.");
      return;
    }
    if (!script.trim()) {
      Alert.alert("Script needed", "This project does not have a generated story/script yet.");
      return;
    }
    onSave(selectedId, title.trim() || "Untitled video", script, description, ratio, captions);
    Alert.alert("Edits saved", "Your title and script changes are saved to this RJ project. Video rendering/export is the next integration stage.");
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>RJ CREATOR STUDIO</Text>
        <Text style={styles.heading}>Video Editor</Text>
        <Text style={styles.sub}>உங்கள் YouTube வீடியோவின் title, script, description மற்றும் format-ஐ இங்கே திருத்தலாம்.</Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.section}>Choose a project</Text>
        {projects.length === 0 ? <Text style={styles.muted}>No projects yet. Create a project in the Create tab first.</Text> : projects.map(project => (
          <Pressable key={project.id} onPress={() => choose(project)} style={[styles.project, selectedId === project.id && styles.projectActive]}>
            <Text style={styles.projectTitle}>{project.topic}</Text>
            <Text style={styles.muted}>{project.language} · {project.status}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.panel}>
        <Text style={styles.section}>Video details</Text>
        <Text style={styles.label}>YouTube title</Text>
        <TextInput value={title} onChangeText={setTitle} placeholder="Video title" placeholderTextColor="#777" style={styles.input} />
        <Text style={styles.label}>Description draft</Text>
        <TextInput value={description} onChangeText={setDescription} multiline placeholder="Video description" placeholderTextColor="#777" style={[styles.input, styles.multiline]} />
        <Text style={styles.label}>Video format</Text>
        <View style={styles.row}>
          {(["16:9", "9:16", "1:1"] as const).map(value => (
            <Pressable key={value} onPress={() => setRatio(value)} style={[styles.choice, ratio === value && styles.choiceActive]}>
              <Text style={styles.choiceText}>{value}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={() => setCaptions(v => !v)} style={styles.toggle}>
          <Text style={styles.toggleText}>Tamil / selected-language captions</Text>
          <Text style={{ color: captions ? "#53C98B" : "#F0A23A", fontWeight: "800" }}>{captions ? "ON" : "OFF"}</Text>
        </Pressable>
        <Text style={styles.label}>Edit script / narration</Text>
        <TextInput value={script} onChangeText={setScript} multiline placeholder="Generated story or narration will appear here..." placeholderTextColor="#777" style={[styles.input, styles.script]} textAlignVertical="top" />
        <Pressable onPress={save} style={styles.save}><Text style={styles.saveText}>SAVE PROJECT EDITS</Text></Pressable>
        <Text style={styles.note}>Current build saves title and script edits to your project. Actual video-file trimming, transitions, audio mixing, rendering and export need the media-rendering engine, which is not connected yet. Format/caption selections are currently editor settings, not rendered output.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: 20 },
  hero: { paddingVertical: 12, paddingHorizontal: 4 },
  eyebrow: { color: RED, fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  heading: { color: "#FFF", fontSize: 25, fontWeight: "900", marginTop: 7 },
  sub: { color: "#A3A3A3", fontSize: 13, lineHeight: 20, marginTop: 8 },
  panel: { backgroundColor: "#151515", borderRadius: 16, borderWidth: 1, borderColor: "#292929", padding: 15, marginBottom: 13 },
  section: { color: "#FFF", fontSize: 16, fontWeight: "800", marginBottom: 10 },
  muted: { color: "#A3A3A3", fontSize: 11, lineHeight: 17 },
  project: { padding: 11, borderRadius: 10, backgroundColor: "#202020", marginTop: 7, borderWidth: 1, borderColor: "#333" },
  projectActive: { borderColor: RED, backgroundColor: "#321219" },
  projectTitle: { color: "#FFF", fontSize: 13, fontWeight: "800", marginBottom: 4 },
  label: { color: "#E2E2E2", fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  input: { minHeight: 46, color: "#FFF", backgroundColor: "#0D0D0D", borderWidth: 1, borderColor: "#393939", borderRadius: 10, paddingHorizontal: 11, paddingVertical: 10, fontSize: 13 },
  multiline: { minHeight: 85, textAlignVertical: "top" },
  script: { minHeight: 260, textAlignVertical: "top", lineHeight: 20 },
  row: { flexDirection: "row", gap: 8 },
  choice: { borderRadius: 9, borderWidth: 1, borderColor: "#414141", paddingHorizontal: 16, paddingVertical: 10, backgroundColor: "#101010" },
  choiceActive: { borderColor: RED, backgroundColor: "#4A1119" },
  choiceText: { color: "#FFF", fontSize: 12, fontWeight: "800" },
  toggle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: "#303030" },
  toggleText: { color: "#DDD", fontSize: 12, fontWeight: "700" },
  save: { minHeight: 48, backgroundColor: RED, borderRadius: 11, justifyContent: "center", alignItems: "center", marginTop: 16 },
  saveText: { color: "#FFF", fontSize: 12, fontWeight: "900" },
  note: { color: "#858585", fontSize: 10, lineHeight: 16, marginTop: 11 },
});
