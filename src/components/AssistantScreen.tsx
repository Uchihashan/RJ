import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";

type Message = { role: "user" | "assistant"; content: string };
const RED = "#F3263D";

export default function AssistantScreen() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "வணக்கம்! நான் RJ. தமிழ், Tanglish அல்லது English-ல் பேசலாம். என்ன வேலை செய்ய வேண்டும்?" },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canSend = useMemo(() => !!draft.trim() && !busy, [draft, busy]);

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    if (!supabase) {
      setError("RJ cloud connection is not configured in this build.");
      return;
    }
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setDraft("");
    setError("");
    setBusy(true);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("rj-assistant", {
        body: { messages: next.slice(-16) },
      });
      if (invokeError) throw invokeError;
      if (!data?.reply) throw new Error(data?.error ?? "RJ did not return a reply.");
      setMessages(current => [...current, { role: "assistant", content: String(data.reply) }]);
    } catch (e: any) {
      setError(e?.message ?? "RJ AI could not connect. Check your internet and provider settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>RJ CENTRAL BRAIN</Text>
        <Text style={styles.heading}>Talk to RJ</Text>
        <Text style={styles.sub}>Tamil • Tanglish • English · Gemini first, OpenRouter fallback</Text>
      </View>
      <ScrollView style={styles.chat} contentContainerStyle={{ paddingBottom: 14 }} keyboardShouldPersistTaps="handled">
        {messages.map((message, index) => (
          <View key={index} style={[styles.bubble, message.role === "user" ? styles.userBubble : styles.assistantBubble]}>
            <Text style={styles.role}>{message.role === "user" ? "YOU" : "RJ AI"}</Text>
            <Text style={styles.message}>{message.content}</Text>
          </View>
        ))}
        {busy ? <View style={styles.loading}><ActivityIndicator color={RED} /><Text style={styles.sub}>RJ is thinking…</Text></View> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="RJ, enakku help pannu..."
          placeholderTextColor="#777"
          multiline
          style={styles.input}
          editable={!busy}
        />
        <Pressable accessibilityRole="button" onPress={send} disabled={!canSend} style={[styles.send, !canSend && { opacity: 0.45 }]}>
          <Text style={styles.sendText}>{busy ? "..." : "SEND"}</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>AI answers use your connected provider. RJ will not claim to upload, publish, or edit a rendered video until those tools are actually connected.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 560 },
  hero: { paddingVertical: 12, paddingHorizontal: 4 },
  eyebrow: { color: RED, fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  heading: { color: "#FFF", fontSize: 25, fontWeight: "900", marginTop: 7 },
  sub: { color: "#A3A3A3", fontSize: 12, lineHeight: 18, marginTop: 6 },
  chat: { flex: 1, maxHeight: 430, backgroundColor: "#101010", borderRadius: 15, borderWidth: 1, borderColor: "#292929", padding: 10 },
  bubble: { padding: 12, borderRadius: 13, marginBottom: 10, maxWidth: "94%" },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#40121A", borderWidth: 1, borderColor: "#70202D" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#202020", borderWidth: 1, borderColor: "#343434" },
  role: { color: RED, fontSize: 9, fontWeight: "900", letterSpacing: 1, marginBottom: 5 },
  message: { color: "#F0F0F0", fontSize: 14, lineHeight: 21 },
  loading: { flexDirection: "row", alignItems: "center", gap: 9, padding: 8 },
  error: { color: "#FF9B9B", fontSize: 12, lineHeight: 18, marginTop: 8 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginTop: 10 },
  input: { flex: 1, minHeight: 48, maxHeight: 110, color: "#FFF", backgroundColor: "#151515", borderWidth: 1, borderColor: "#393939", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14 },
  send: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: RED, alignItems: "center", justifyContent: "center" },
  sendText: { color: "#FFF", fontSize: 12, fontWeight: "900" },
  note: { color: "#858585", fontSize: 10, lineHeight: 15, marginTop: 9, marginBottom: 12 },
});
