import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

type Message = { role: "user" | "assistant"; content: string };
type Pending = { title: string; detail: string; tool: ToolKey; arguments: Record<string, string>; run: () => Promise<string> };
type ToolKey = "video.create" | "reminder.create" | "navigation.open" | "youtube.upload";
type ProjectOption = { id: string; topic: string; renderPath?: string; youtubeVideoId?: string };
type Props = { projects: ProjectOption[]; onUploadYoutube: (jobId: string) => Promise<string>; onCreateVideoProject: (topic: string) => Promise<string>; onCreateReminder: (title: string, time: string) => Promise<string>; onNavigate: (tab: string) => Promise<string>; onBeginAgentAction: (tool: ToolKey, args: Record<string, string>) => Promise<string>; onFinishAgentAction: (requestId: string, status: "succeeded" | "failed", summary: string) => Promise<void> };
const RED = "#F3263D";
const WELCOME: Message = {
  role: "assistant",
  content: "வணக்கம்! நான் RJ. தமிழ், Tanglish அல்லது English-ல் பேசலாம். என்ன வேலை செய்ய வேண்டும்?",
};

export default function AssistantScreen({ projects, onUploadYoutube, onCreateVideoProject, onCreateReminder, onNavigate, onBeginAgentAction, onFinishAgentAction }: Props) {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageKey, setStorageKey] = useState("rj_chat_history_guest");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const canSend = useMemo(() => !!draft.trim() && !busy && !actionBusy, [draft, busy, actionBusy]);

  useEffect(() => {
    let active = true;
    const loadForUser = async (userId?: string) => {
      const nextKey = userId ? "rj_chat_history_" + userId : "rj_chat_history_guest";
      if (active) {
        setHistoryLoaded(false);
        setStorageKey(nextKey);
        setMessages([WELCOME]);
        setError("");
      }
      try {
        const saved = await AsyncStorage.getItem(nextKey);
        const parsed = saved ? JSON.parse(saved) as Message[] : [];
        if (active) {
          const valid = Array.isArray(parsed)
            ? parsed.filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string").slice(-80)
            : [];
          setMessages(valid.length ? valid : [WELCOME]);
          setHistoryLoaded(true);
        }
      } catch {
        if (active) setHistoryLoaded(true);
      }
    };

    supabase?.auth.getSession().then(({ data }) => loadForUser(data.session?.user.id)).catch(() => loadForUser());
    const { data: authListener } = supabase?.auth.onAuthStateChange((_event, session) => {
      void loadForUser(session?.user.id);
    }) ?? { data: { subscription: null } };

    return () => {
      active = false;
      authListener?.subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    AsyncStorage.setItem(storageKey, JSON.stringify(messages.slice(-80))).catch(() => {
      setError("RJ could not save this chat on your device.");
    });
  }, [messages, storageKey, historyLoaded]);

  const clearChat = async () => {
    if (busy || actionBusy) return;
    setMessages([WELCOME]);
    setPending(null);
    setActionBusy(false);
    setError("");
    await AsyncStorage.removeItem(storageKey).catch(() => undefined);
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next); setDraft(""); setError("");
    // A fresh user message cancels any older unconfirmed action.
    setPending(null);
    const video = content.match(/^(?:(?:create|make)\s+(?:a\s+)?video|video\s+create|வீடியோ\s+உருவாக்கு)\s*[:\-]\s*(.+)$/i)
      ?? content.match(/^(?:create|make)\s+(?:a\s+)?video\s+(.+)$/i);
    const reminder = content.match(/^(?:remind me to|remind me|nyabagam paduthu|நினைவூட்டு)\s+(.+?)\s+(?:at|க்கு)\s*((?:[01]?\d|2[0-3]):[0-5]\d)$/i);
    const nav = content.match(/^(?:open|go to|திற|thira|thirakka)\s+(create|edit|tools|schedule|settings|home|உருவாக்கு|திருத்து|கருவிகள்|அட்டவணை|அமைப்புகள்|முகப்பு)$/i);
    if (video) { setPending({ title: "Create video project", detail: video[1], tool: "video.create", arguments: { topic: video[1].trim() }, run: () => onCreateVideoProject(video[1].trim()) }); setMessages(v => [...v, { role: "assistant", content: "இந்த video project-ஐ queue-ல் சேர்க்கலாமா? Confirm அழுத்தினால் மட்டும் சேர்க்கப்படும்." }]); return; }
    if (reminder) { setPending({ title: "Save reminder", detail: reminder[1] + " at " + reminder[2], tool: "reminder.create", arguments: { title: reminder[1].trim(), time: reminder[2] }, run: () => onCreateReminder(reminder[1].trim(), reminder[2]) }); setMessages(v => [...v, { role: "assistant", content: "இந்த reminder-ஐ சேமிக்கலாமா? Confirm அழுத்தினால் மட்டும் சேமிக்கப்படும்." }]); return; }
    if (nav) { const aliases: Record<string, string> = { "உருவாக்கு": "Create", "திருத்து": "Edit", "கருவிகள்": "Tools", "அட்டவணை": "Schedule", "அமைப்புகள்": "Settings", "முகப்பு": "Home" }; const raw = nav[1].toLowerCase(); const tab = aliases[nav[1]] ?? raw[0].toUpperCase() + raw.slice(1); setPending({ title: "Open " + tab, detail: "RJ " + tab + " screen", tool: "navigation.open", arguments: { tab }, run: () => onNavigate(tab) }); setMessages(v => [...v, { role: "assistant", content: tab + " screen-ஐ திறக்கலாமா?" }]); return; }
    if (!supabase) {
      setError("RJ cloud connection is not configured in this build.");
      return;
    }
    setBusy(true);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("rj-assistant", {
        body: { messages: next.slice(-16), context: { rendered_projects: projects.slice(0, 10).map(project => ({ id: project.id, topic: project.topic })) } },
      });
      if (invokeError) throw invokeError;
      if (!data?.reply) throw new Error(data?.error ?? "RJ did not return a reply.");
      const proposed = data.action && typeof data.action === "object" ? data.action : null;
      const tool = typeof proposed?.tool === "string" ? proposed.tool : "";
      const args = proposed?.arguments && typeof proposed.arguments === "object" ? proposed.arguments : {};
      let prepared: Pending | null = null;
      if (tool === "video.create" && typeof args.topic === "string" && args.topic.trim()) {
        const topic = args.topic.trim().slice(0, 180);
        prepared = { title: "Create video project", detail: topic, tool, arguments: { topic }, run: () => onCreateVideoProject(topic) };
      } else if (tool === "reminder.create" && typeof args.title === "string" && typeof args.time === "string" && /^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(args.time)) {
        const title = args.title.trim().slice(0, 120);
        const time = args.time;
        if (title) prepared = { title: "Save reminder", detail: title + " at " + time, tool, arguments: { title, time }, run: () => onCreateReminder(title, time) };
      } else if (tool === "navigation.open" && typeof args.tab === "string" && ["Home", "Create", "Edit", "Tools", "Schedule", "Settings"].includes(args.tab)) {
        const tab = args.tab;
        prepared = { title: "Open " + tab, detail: "RJ " + tab + " screen", tool, arguments: { tab }, run: () => onNavigate(tab) };
      } else if (tool === "youtube.upload" && typeof args.job_id === "string") {
        const project = projects.find(item => item.id === args.job_id && !!item.renderPath && !item.youtubeVideoId);
        if (project) prepared = { title: "Upload video privately to YouTube", detail: project.topic, tool, arguments: { job_id: project.id }, run: () => onUploadYoutube(project.id) };
      }
      setMessages(current => [...current, { role: "assistant", content: String(data.reply) }]);
      if (prepared) setPending(prepared);
    } catch (e: any) {
      setError(e?.message ?? "RJ AI could not connect. Check your internet and provider settings.");
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending || actionBusy) return;
    setActionBusy(true);
    let requestId = "";
    try {
      requestId = await onBeginAgentAction(pending.tool, pending.arguments);
      let result = "";
      try {
        result = await pending.run();
      } catch (e: any) {
        await onFinishAgentAction(requestId, "failed", e?.message ?? "Action failed");
        throw e;
      }
      setMessages(v => [...v, { role: "assistant", content: result }]);
      setPending(null);
      try {
        await onFinishAgentAction(requestId, "succeeded", result);
      } catch {
        setError("Action completed, but RJ could not update its audit status. Please check your connection before retrying.");
      }
    } catch (e: any) {
      setError(e?.message ?? "RJ action failed.");
    } finally { setActionBusy(false); }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>RJ CENTRAL BRAIN</Text>
            <Text style={styles.heading}>Talk to RJ</Text>
            <Text style={styles.sub}>Tamil • Tanglish • English · OpenRouter Free, Groq Free fallback</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={clearChat} disabled={busy || actionBusy} style={styles.clearButton}>
            <Text style={styles.clearText}>CLEAR CHAT</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView style={styles.chat} contentContainerStyle={{ paddingBottom: 14 }} keyboardShouldPersistTaps="handled">
        {messages.map((message, index) => (
          <View key={index} style={[styles.bubble, message.role === "user" ? styles.userBubble : styles.assistantBubble]}>
            <Text style={styles.role}>{message.role === "user" ? "YOU" : "RJ AI"}</Text>
            <Text style={styles.message}>{message.content}</Text>
          </View>
        ))}
        {busy ? <View style={styles.loading}><ActivityIndicator color={RED} /><Text style={styles.sub}>RJ is thinking…</Text></View> : null}
        {pending ? <View style={styles.actionCard}>
          <Text style={styles.actionHeading}>{pending.title.toUpperCase()}</Text>
          <Text style={styles.actionDetail}>{pending.detail}</Text>
          <View style={styles.actionButtons}>
            <Pressable accessibilityRole="button" disabled={actionBusy} onPress={confirmPending} style={styles.confirmButton}><Text style={styles.confirmText}>{actionBusy ? "WORKING..." : "CONFIRM"}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={actionBusy} onPress={() => setPending(null)} style={styles.cancelButton}><Text style={styles.cancelText}>CANCEL</Text></Pressable>
          </View>
        </View> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="RJ, enakku help pannu..."
          placeholderTextColor="#777"
          multiline
          style={styles.input}
          editable={!busy && !actionBusy}
        />
        <Pressable accessibilityRole="button" onPress={send} disabled={!canSend} style={[styles.send, !canSend && { opacity: 0.45 }]}>
          <Text style={styles.sendText}>{busy ? "..." : "SEND"}</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>Chat history is saved separately on this device for each signed-in account. AI answers use your connected provider. RJ will not claim to upload, publish, or edit a rendered video until those tools are connected.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0 },
  hero: { paddingVertical: 12, paddingHorizontal: 4 },
  heroTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  heroCopy: { flex: 1 },
  eyebrow: { color: RED, fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  heading: { color: "#FFF", fontSize: 25, fontWeight: "900", marginTop: 7 },
  sub: { color: "#A3A3A3", fontSize: 12, lineHeight: 18, marginTop: 6 },
  clearButton: { minHeight: 40, paddingHorizontal: 10, justifyContent: "center", borderWidth: 1, borderColor: "#454545", borderRadius: 9 },
  clearText: { color: "#DDD", fontSize: 9, fontWeight: "900" },
  chat: { flex: 1, minHeight: 0, backgroundColor: "#101010", borderRadius: 15, borderWidth: 1, borderColor: "#292929", padding: 10 },
  bubble: { padding: 12, borderRadius: 13, marginBottom: 10, maxWidth: "94%" },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#40121A", borderWidth: 1, borderColor: "#70202D" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#202020", borderWidth: 1, borderColor: "#343434" },
  role: { color: RED, fontSize: 9, fontWeight: "900", letterSpacing: 1, marginBottom: 5 },
  message: { color: "#F0F0F0", fontSize: 14, lineHeight: 21 },
  loading: { flexDirection: "row", alignItems: "center", gap: 9, padding: 8 },
  actionCard: { backgroundColor: "#261217", borderWidth: 1, borderColor: RED, borderRadius: 12, padding: 12, marginBottom: 10 },
  actionHeading: { color: RED, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  actionDetail: { color: "#FFF", fontSize: 13, lineHeight: 19, marginTop: 7 },
  actionButtons: { flexDirection: "row", gap: 8, marginTop: 10 },
  confirmButton: { flex: 1, minHeight: 40, backgroundColor: RED, borderRadius: 9, justifyContent: "center", alignItems: "center" },
  confirmText: { color: "#FFF", fontSize: 11, fontWeight: "900" },
  cancelButton: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: "#777", borderRadius: 9, justifyContent: "center", alignItems: "center" },
  cancelText: { color: "#DDD", fontSize: 11, fontWeight: "900" },
  error: { color: "#FF9B9B", fontSize: 12, lineHeight: 18, marginTop: 8 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginTop: 10 },
  input: { flex: 1, minHeight: 48, maxHeight: 110, color: "#FFF", backgroundColor: "#151515", borderWidth: 1, borderColor: "#393939", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14 },
  send: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: RED, alignItems: "center", justifyContent: "center" },
  sendText: { color: "#FFF", fontSize: 12, fontWeight: "900" },
  note: { color: "#858585", fontSize: 10, lineHeight: 15, marginTop: 9, marginBottom: 12 },
});
