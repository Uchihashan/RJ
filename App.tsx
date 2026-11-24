import React, { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";

type Tab = "Home" | "Create" | "Schedule" | "Settings";
type Job = { id: string; topic: string; language: string; createdAt: string; status: string };
type Reminder = { id: string; title: string; time: string; notificationId: string | null };

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false })
});

const RED = "#F3263D";
const BG = "#080808";
const PANEL = "#151515";
const MUTED = "#A3A3A3";

function ActionButton({ title, onPress, secondary = false, disabled = false }: {
  title: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        secondary && styles.secondaryButton,
        disabled && styles.disabledButton,
        pressed && !disabled && { opacity: 0.78 }
      ]}
    >
      <Text style={[styles.actionButtonText, secondary && { color: "#FFFFFF" }]}>{title}</Text>
    </Pressable>
  );
}

function Field({ label, value, onChangeText, placeholder, secureTextEntry = false, multiline = false }: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder: string;
  secureTextEntry?: boolean; multiline?: boolean;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#777777"
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        style={[styles.input, multiline && { minHeight: 100, paddingTop: 14 }]}
      />
    </View>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("Home");
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("Tamil");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [chat, setChat] = useState("");
  const [chatReply, setChatReply] = useState("வணக்கம்! இன்று என்ன வேலை செய்யலாம்? / Vanakkam! What shall we work on today?");
  const [scheduleTitle, setScheduleTitle] = useState("");
  const [scheduleTime, setScheduleTime] = useState("18:00");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [pin, setPin] = useState("");
  const [pinConfigured, setPinConfigured] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const [unlockPin, setUnlockPin] = useState("");

  useEffect(() => {
    (async () => {
      const savedJobs = await AsyncStorage.getItem("rj_video_jobs");
      const savedReminders = await AsyncStorage.getItem("rj_reminders");
      if (savedJobs) setJobs(JSON.parse(savedJobs) as Job[]);
      if (savedReminders) setReminders(JSON.parse(savedReminders) as Reminder[]);
      const savedPin = await SecureStore.getItemAsync("rj_local_pin");
      const savedBio = await SecureStore.getItemAsync("rj_biometric_enabled");
      const savedPassword = await SecureStore.getItemAsync("rj_local_password");
      setPinConfigured(!!savedPin);
      setPasswordConfigured(!!savedPassword);
      setLocked(!!savedPin || !!savedPassword);
      setBiometricEnabled(savedBio === "true");
      const hardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(hardware && enrolled);
      setDataLoaded(true);
    })().catch(() => {
      Alert.alert("RJ startup issue", "Some saved settings could not be loaded. Please reopen RJ.");
      setDataLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!dataLoaded) return;
    AsyncStorage.multiSet([
      ["rj_video_jobs", JSON.stringify(jobs)],
      ["rj_reminders", JSON.stringify(reminders)]
    ]).catch(() => Alert.alert("Storage issue", "RJ could not save local project data."));
  }, [jobs, reminders, dataLoaded]);

  const createJob = () => {
    const clean = topic.trim();
    if (!clean) {
      Alert.alert("Topic needed", "Enter a video heading or story topic first.");
      return;
    }
    const item: Job = {
      id: String(Date.now()),
      topic: clean,
      language,
      createdAt: new Date().toLocaleString(),
      status: "Saved — AI connection required"
    };
    setJobs(current => [item, ...current]);
    setTopic("");
    Alert.alert("Saved to RJ", "Your video idea is saved. Connect an AI video service to generate the full video.");
    setTab("Create");
  };

  const sendChat = () => {
    const message = chat.trim();
    if (!message) return;
    setChatReply("I received: “" + message + "”. The assistant workflow and AI provider still need to be connected in the next build stage.");
    setChat("");
  };

  const addReminder = async () => {
    const title = scheduleTitle.trim();
    if (!title) {
      Alert.alert("Reminder needed", "Enter what you want RJ to remind you about.");
      return;
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
      Alert.alert("Time not valid", "Use 24-hour format, for example 18:30.");
      return;
    }
    let notificationId: string | null = null;
    try {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("rj-reminders", {
          name: "RJ reminders", importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250], lightColor: RED
        });
      }
      const current = await Notifications.getPermissionsAsync();
      const permission = current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
      if (permission.status === "granted") {
        const [hour, minute] = scheduleTime.split(":").map(Number);
        const date = new Date();
        date.setHours(hour, minute, 0, 0);
        if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
        notificationId = await Notifications.scheduleNotificationAsync({
          content: { title: "RJ Reminder", body: title, sound: "default" },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: "rj-reminders" }
        });
      }
    } catch {
      Alert.alert("Notification unavailable", "The reminder will still be saved inside RJ, but Android notification scheduling failed.");
    }
    const item: Reminder = { id: String(Date.now()), title, time: scheduleTime, notificationId };
    setReminders(current => [item, ...current]);
    setScheduleTitle("");
    Alert.alert("Reminder saved", notificationId ? "RJ will notify you at the selected time." : "Saved in RJ. Allow notifications in Android settings to receive an alert.");
  };

  const savePin = async () => {
    if (!/^\d{4,8}$/.test(pin)) {
      Alert.alert("PIN not valid", "Use 4 to 8 digits.");
      return;
    }
    await SecureStore.setItemAsync("rj_local_pin", pin);
    setPin("");
    setPinConfigured(true);
    Alert.alert("PIN saved", "Your PIN is stored securely on this device.");
  };

  const savePassword = async () => {
    const clean = password.trim();
    if (clean.length < 8) {
      Alert.alert("Password too short", "Use at least 8 characters.");
      return;
    }
    await SecureStore.setItemAsync("rj_local_password", clean);
    setPassword("");
    setPasswordConfigured(true);
    Alert.alert("Password saved", "Your password is stored securely on this device.");
  };

  const unlockWithPassword = async () => {
    const savedPassword = await SecureStore.getItemAsync("rj_local_password");
    if (savedPassword && unlockPassword === savedPassword) {
      setLocked(false);
      setUnlockPassword("");
    } else {
      Alert.alert("Incorrect password", "Please try again.");
    }
  };

  const toggleBiometric = async () => {
    if (!biometricAvailable) {
      Alert.alert("Fingerprint unavailable", "Set up fingerprint or face unlock in your Android phone settings first.");
      return;
    }
    if (!biometricEnabled) {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Enable RJ biometric unlock" });
      if (!result.success) return;
      await SecureStore.setItemAsync("rj_biometric_enabled", "true");
      setBiometricEnabled(true);
    } else {
      await SecureStore.setItemAsync("rj_biometric_enabled", "false");
      setBiometricEnabled(false);
    }
  };

  const unlockWithBiometric = async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock RJ" });
    if (result.success) setLocked(false);
  };

  const unlockWithPin = async () => {
    const savedPin = await SecureStore.getItemAsync("rj_local_pin");
    if (savedPin && unlockPin === savedPin) {
      setLocked(false);
      setUnlockPin("");
    } else {
      Alert.alert("Incorrect PIN", "Please try again.");
    }
  };

  const renderHome = () => (
    <>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>PERSONAL AI WORKSPACE</Text>
        <Text style={styles.heroTitle}>Hello! <Text style={{ color: RED }}>RJ</Text></Text>
        <Text style={styles.heroSub}>உங்கள் அடுத்த வேலையைச் சொல்லுங்கள்.</Text>
        <Text style={styles.heroSub}>Tell RJ what you want to get done today.</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Assistant</Text>
        <Text style={styles.reply}>{chatReply}</Text>
        <Field label="Your message" value={chat} onChangeText={setChat} placeholder="Tamil / Tanglish / English..." multiline />
        <ActionButton title="Send message" onPress={sendChat} />
        <Text style={styles.note}>AI replies are not connected yet. This screen is ready for the assistant backend.</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Quick actions</Text>
        <View style={styles.quickRow}>
          <Pressable style={styles.quickTile} onPress={() => setTab("Create")}><Text style={styles.quickIcon}>▶</Text><Text style={styles.quickText}>Create kids video</Text></Pressable>
          <Pressable style={styles.quickTile} onPress={() => setTab("Schedule")}><Text style={styles.quickIcon}>◷</Text><Text style={styles.quickText}>Today's schedule</Text></Pressable>
        </View>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Today's reminders</Text>
        {reminders.length === 0 ? <Text style={styles.muted}>No reminders saved yet.</Text> : reminders.map(r => <Text key={r.id} style={styles.listLine}>• {r.title} • {r.time}</Text>)}
      </View>
    </>
  );

  const renderCreate = () => (
    <View style={styles.panel}>
      <Text style={styles.sectionTitle}>YouTube video studio</Text>
      <Text style={styles.muted}>Enter a heading or story idea. RJ will save it as a project.</Text>
      <Field label="Video heading / topic" value={topic} onChangeText={setTopic} placeholder="Example: குட்டி யானையின் நல்ல மனசு" multiline />
      <Text style={styles.fieldLabel}>Video language</Text>
      <View style={styles.choiceRow}>
        {["Tamil", "Tanglish", "English"].map(item => (
          <Pressable key={item} onPress={() => setLanguage(item)} style={[styles.choice, language === item && styles.choiceActive]}>
            <Text style={[styles.choiceText, language === item && { color: "#FFFFFF" }]}>{item}</Text>
          </Pressable>
        ))}
      </View>
      <ActionButton title="Save video idea" onPress={createJob} />
      <Text style={styles.note}>Full story writing, voice-over, visuals, subtitles, editing and YouTube upload need AI and YouTube connections. They are not active yet.</Text>
      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Your video projects</Text>
      {jobs.length === 0 ? <Text style={styles.muted}>No projects yet. Add your first topic above.</Text> : jobs.map(job => (
        <View key={job.id} style={styles.jobCard}>
          <Text style={styles.jobTitle}>{job.topic}</Text>
          <Text style={styles.muted}>{job.language} • {job.createdAt}</Text>
          <Text style={styles.jobStatus}>{job.status}</Text>
        </View>
      ))}
    </View>
  );

  const renderSchedule = () => (
    <View style={styles.panel}>
      <Text style={styles.sectionTitle}>Schedule & reminders</Text>
      <Text style={styles.muted}>Add a task you want to remember.</Text>
      <Field label="Task" value={scheduleTitle} onChangeText={setScheduleTitle} placeholder="Example: Prepare today's kids story" />
      <Field label="Time (24-hour)" value={scheduleTime} onChangeText={setScheduleTime} placeholder="18:00" />
      <ActionButton title="Save reminder" onPress={addReminder} />
      <Text style={styles.note}>RJ schedules local Android notifications. Delivery time can still be affected by Android battery and alarm settings.</Text>
      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Saved reminders</Text>
      {reminders.length === 0 ? <Text style={styles.muted}>Nothing scheduled yet.</Text> : reminders.map((r, i) => <Text key={i} style={styles.listLine}>• {r}</Text>)}
    </View>
  );

  const renderSettings = () => (
    <>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Security</Text>
        <Text style={styles.muted}>Set a local PIN to protect this app on this device.</Text>
        <Field label="New PIN (4–8 digits)" value={pin} onChangeText={setPin} placeholder="Enter PIN" secureTextEntry />
        <ActionButton title={pinConfigured ? "Update PIN" : "Save PIN"} onPress={savePin} />
        <Text style={styles.listLine}>PIN status: {pinConfigured ? "Configured" : "Not configured"}</Text>
        <Field label="New password (minimum 8 characters)" value={password} onChangeText={setPassword} placeholder="Create a password" secureTextEntry />
        <ActionButton title={passwordConfigured ? "Update password" : "Save password"} onPress={savePassword} secondary />
        <Text style={styles.listLine}>Password status: {passwordConfigured ? "Configured" : "Not configured"}</Text>
        <View style={styles.divider} />
        <Text style={styles.sectionTitle}>Fingerprint / biometrics</Text>
        <Text style={styles.muted}>{biometricAvailable ? "Your device supports biometric authentication." : "Fingerprint or face unlock is not set up on this device."}</Text>
        <ActionButton title={biometricEnabled ? "Turn off biometric unlock" : "Enable biometric unlock"} onPress={toggleBiometric} secondary />
        <Text style={styles.listLine}>Biometric unlock: {biometricEnabled ? "On" : "Off"}</Text>
        {pinConfigured && <ActionButton title="Lock RJ now" onPress={() => setLocked(true)} secondary />}
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Connections</Text>
        <Text style={styles.listLine}>AI video provider: <Text style={styles.pending}>Not connected</Text></Text>
        <Text style={styles.listLine}>YouTube account: <Text style={styles.pending}>Not connected</Text></Text>
        <Text style={styles.listLine}>Cloud sync: <Text style={styles.pending}>Not connected</Text></Text>
        <Text style={styles.note}>Connection setup will be added after the core app screens are tested. Never paste API keys into public code.</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>About RJ</Text>
        <Text style={styles.muted}>Personal Android assistant • Black + Red • Tamil / Tanglish / English</Text>
        <Text style={styles.muted}>Version 1.0.0 — foundation build</Text>
      </View>
    </>
  );

  if (!dataLoaded) {
    return <View style={[styles.screen, styles.lockScreen]}><StatusBar style="light" /><Text style={styles.brand}>RJ<Text style={{ color: RED }}>.</Text></Text><Text style={styles.muted}>Loading your secure workspace…</Text></View>;
  }

  if (locked) {
    return (
      <View style={[styles.screen, styles.lockScreen]}>
        <StatusBar style="light" />
        <Text style={styles.brand}>RJ</Text>
        <Text style={styles.heroSub}>App locked</Text>
        <Field label="Enter PIN" value={unlockPin} onChangeText={setUnlockPin} placeholder="PIN" secureTextEntry />
        <ActionButton title="Unlock with PIN" onPress={unlockWithPin} />
        <Field label="Or enter password" value={unlockPassword} onChangeText={setUnlockPassword} placeholder="Password" secureTextEntry />
        <ActionButton title="Unlock with password" onPress={unlockWithPassword} secondary />
        {biometricEnabled && <ActionButton title="Unlock with fingerprint" onPress={unlockWithBiometric} secondary />}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>RJ<Text style={{ color: RED }}>.</Text></Text>
          <Text style={styles.headerCaption}>YOUR PERSONAL WORKSPACE</Text>
        </View>
        <View style={styles.liveDot}><View style={styles.dot} /><Text style={styles.liveText}>READY</Text></View>
      </View>
      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
        {tab === "Home" && renderHome()}
        {tab === "Create" && renderCreate()}
        {tab === "Schedule" && renderSchedule()}
        {tab === "Settings" && renderSettings()}
      </ScrollView>
      <View style={styles.tabBar}>
        {(["Home", "Create", "Schedule", "Settings"] as Tab[]).map(item => (
          <Pressable key={item} onPress={() => setTab(item)} style={styles.tabItem}>
            <Text style={[styles.tabIcon, tab === item && { color: RED }]}>{item === "Home" ? "⌂" : item === "Create" ? "＋" : item === "Schedule" ? "◷" : "⚙"}</Text>
            <Text style={[styles.tabLabel, tab === item && { color: "#FFFFFF" }]}>{item}</Text>
            {tab === item && <View style={styles.tabUnderline} />}
          </Pressable>
        ))}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  lockScreen: { justifyContent: "center", padding: 24 },
  header: { paddingTop: Platform.OS === "android" ? 18 : 54, paddingHorizontal: 22, paddingBottom: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#242424" },
  brand: { color: "#FFFFFF", fontSize: 30, fontWeight: "900", letterSpacing: 2 },
  headerCaption: { color: MUTED, fontSize: 9, letterSpacing: 2, marginTop: 2 },
  liveDot: { flexDirection: "row", alignItems: "center", backgroundColor: "#1A1A1A", borderRadius: 30, paddingHorizontal: 11, paddingVertical: 7, gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 5, backgroundColor: RED },
  liveText: { color: "#DDDDDD", fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 18 },
  hero: { paddingVertical: 20, paddingHorizontal: 4 },
  eyebrow: { color: RED, fontSize: 10, fontWeight: "800", letterSpacing: 2 },
  heroTitle: { color: "#FFFFFF", fontSize: 34, fontWeight: "900", marginTop: 8 },
  heroSub: { color: "#C4C4C4", fontSize: 14, marginTop: 6, lineHeight: 21 },
  panel: { backgroundColor: PANEL, borderRadius: 18, borderWidth: 1, borderColor: "#292929", padding: 17, marginBottom: 14 },
  sectionTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "800", marginBottom: 12 },
  reply: { color: "#E8E8E8", fontSize: 14, lineHeight: 22, backgroundColor: "#202020", borderRadius: 12, padding: 13, marginBottom: 14 },
  muted: { color: MUTED, fontSize: 13, lineHeight: 20 },
  fieldWrap: { marginTop: 12, marginBottom: 4 },
  fieldLabel: { color: "#E0E0E0", fontSize: 12, fontWeight: "700", marginBottom: 7 },
  input: { minHeight: 48, borderWidth: 1, borderColor: "#393939", borderRadius: 11, backgroundColor: "#0D0D0D", color: "#FFFFFF", paddingHorizontal: 13, fontSize: 14 },
  actionButton: { minHeight: 48, borderRadius: 12, backgroundColor: RED, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, marginTop: 13 },
  secondaryButton: { backgroundColor: "#242424", borderWidth: 1, borderColor: "#444444" },
  disabledButton: { opacity: 0.45 },
  actionButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  note: { color: "#8D8D8D", fontSize: 11, lineHeight: 17, marginTop: 12 },
  quickRow: { flexDirection: "row", gap: 10 },
  quickTile: { flex: 1, minHeight: 92, borderRadius: 13, backgroundColor: "#202020", padding: 13, justifyContent: "center" },
  quickIcon: { color: RED, fontSize: 24, fontWeight: "800", marginBottom: 8 },
  quickText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  choiceRow: { flexDirection: "row", gap: 8, marginTop: 5, marginBottom: 8 },
  choice: { borderRadius: 10, borderWidth: 1, borderColor: "#414141", paddingHorizontal: 14, paddingVertical: 11, backgroundColor: "#101010" },
  choiceActive: { borderColor: RED, backgroundColor: "#4A1119" },
  choiceText: { color: "#BBBBBB", fontSize: 12, fontWeight: "700" },
  divider: { height: 1, backgroundColor: "#303030", marginVertical: 17 },
  jobCard: { backgroundColor: "#202020", borderRadius: 12, padding: 13, marginTop: 10 },
  jobTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "800", marginBottom: 5 },
  jobStatus: { color: RED, fontSize: 11, fontWeight: "700", marginTop: 7 },
  listLine: { color: "#D8D8D8", fontSize: 13, lineHeight: 22, marginTop: 7 },
  pending: { color: "#F0A23A", fontWeight: "700" },
  tabBar: { minHeight: 66, flexDirection: "row", backgroundColor: "#101010", borderTopWidth: 1, borderTopColor: "#2A2A2A", paddingBottom: Platform.OS === "android" ? 5 : 18 },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 58, gap: 2 },
  tabIcon: { color: "#888888", fontSize: 21 },
  tabLabel: { color: "#888888", fontSize: 10, fontWeight: "700" },
  tabUnderline: { width: 20, height: 2, backgroundColor: RED, borderRadius: 2, marginTop: 2 }
});