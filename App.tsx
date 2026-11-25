import React, { useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { supabase } from "./src/lib/supabase";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Alert,
  Image,
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
import ToolHubScreen from "./src/components/ToolHubScreen";
import AssistantScreen from "./src/components/AssistantScreen";
import VideoEditorScreen from "./src/components/VideoEditorScreen";

type Tab = "Home" | "Chat" | "Create" | "Edit" | "Tools" | "Schedule" | "Settings";
type Job = { id: string; topic: string; language: string; createdAt: string; status: string; story?: string; description?: string; aspectRatio?: string; captionsEnabled?: boolean; renderPath?: string; thumbnailPath?: string; captionsPath?: string; renderDuration?: number; renderMode?: string; generatedImageCount?: number; sceneAssetCount?: number; hasNarration?: boolean; youtubeVideoId?: string };
type PipelineStage = { job_id: string; stage_key: string; stage_order: number; status: string; selected_provider?: string | null; error_message?: string | null };
const PIPELINE_STAGE_LABELS: Record<string, string> = { brief: "Brief", script_storyboard: "Story & script", scene_assets: "Visual scenes", voice_audio: "Voice-over", captions: "Captions", timeline_edit: "Timeline edit", render_export: "Render video", quality_check: "Quality check", metadata_thumbnail: "Title & thumbnail", youtube_upload: "YouTube upload", youtube_schedule_verify: "Schedule verification" };

function jobStatusLabel(row: any): string {
  if (row.output?.stage === "rendered") {
    const render = row.output?.render ?? {};
    const audioLabel = render.audio === true ? "Tamil narration" : "no narration";
    const visualLabel = Number(render.generated_image_count ?? 0) > 0 ? "AI-generated images" : "local scene artwork";
    return `Video rendered — ${audioLabel}, ${visualLabel}`;
  }
  if (row.status === "blocked") return row.current_stage === "scene_assets" ? "Story saved — waiting for image/video provider" : "Blocked — connect the required provider";
  if (row.output?.stage === "story_ready") return "Story ready — voice, visuals and rendering still pending";
  if (row.status === "queued") return "Queued — RJ worker will check providers";
  if (row.status === "running") return "Generating story…";
  if (row.status === "waiting_retry") return "Provider busy — automatic retry scheduled";
  if (row.status === "paused" && row.error_code === "provider_not_configured") return "Paused — AI provider key needed";
  if (row.status === "paused" && row.error_code === "paid_provider_consent_required") return "Paused — paid provider needs spending controls";
  if (row.status === "paused") return "Paused";
  if (row.status === "completed") return "Completed";
  if (row.status === "failed") return "Failed — check settings and try again";
  return row.status;
}
type Reminder = { id: string; title: string; time: string; notificationId: string | null };
type AgentToolKey = "video.create" | "reminder.create" | "navigation.open" | "youtube.upload";

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false })
  });
}

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
        autoCapitalize={secureTextEntry ? "none" : "sentences"}
        autoCorrect={!secureTextEntry}
        spellCheck={!secureTextEntry}
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
  const [jobStages, setJobStages] = useState<Record<string, PipelineStage[]>>({});
  const [jobsOwnerId, setJobsOwnerId] = useState<string | null>(null);
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
  const [session, setSession] = useState<any>(null);
  const [youtubeConnection, setYoutubeConnection] = useState<"unknown" | "connected" | "denied" | "error">("unknown");
  const [youtubeChannelTitle, setYoutubeChannelTitle] = useState<string | null>(null);
  const [youtubeBusy, setYoutubeBusy] = useState(false);
  const [youtubeUploadingJobId, setYoutubeUploadingJobId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signup");
  const [authBusy, setAuthBusy] = useState(false);
  const [otpPending, setOtpPending] = useState(false);
  const [authOtp, setAuthOtp] = useState("");
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState("");
  const [groqKeyInput, setGroqKeyInput] = useState("");
  const [cloudflareAccountInput, setCloudflareAccountInput] = useState("");
  const [cloudflareTokenInput, setCloudflareTokenInput] = useState("");
  const [cloudflareFreePlanConfirmed, setCloudflareFreePlanConfirmed] = useState(false);
  const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>({});
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [agentPermissions, setAgentPermissions] = useState<Record<string, boolean>>({});
  const [agentPermissionBusy, setAgentPermissionBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    const client = supabase;
    client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    }).catch(() => setAuthReady(true));
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
    });
    return () => {
      subscription.unsubscribe();
      appStateSubscription.remove();
    };
  }, []);


  useEffect(() => {
    if (!session || !supabase) {
      setYoutubeConnection("unknown");
      setYoutubeChannelTitle(null);
      return;
    }
    let active = true;
    supabase.functions.invoke("rj-youtube-oauth", { body: { action: "status" } }).then(({ data, error }) => {
      if (!active) return;
      if (error) { setYoutubeConnection("unknown"); return; }
      setYoutubeConnection(data?.connected ? "connected" : "unknown");
      setYoutubeChannelTitle(typeof data?.channel_title === "string" ? data.channel_title : null);
    }).catch(() => { if (active) setYoutubeConnection("unknown"); });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (!authReady || !dataLoaded) return;
    if (!session || !supabase) {
      let active = true;
      setJobStages({});
      AsyncStorage.getItem("rj_video_jobs_local").then(saved => {
        if (!active) return;
        const localJobs = saved ? JSON.parse(saved) as Job[] : [];
        setJobs(localJobs);
        setJobsOwnerId("local");
      }).catch(() => {
        if (active) { setJobs([]); setJobsOwnerId("local"); }
      });
      return () => { active = false; };
    }
    let active = true;
    setJobs([]);
    setJobStages({});
    setJobsOwnerId(null);
    const userJobsKey = "rj_video_jobs_" + session.user.id;
    let localJobsFallback: Job[] = [];
    (async () => {
      const saved = await AsyncStorage.getItem(userJobsKey);
      const localJobs = saved ? JSON.parse(saved) as Job[] : [];
      localJobsFallback = localJobs;
      if (active) setJobs(localJobs);
      const { data, error } = await supabase.from("jobs")
        .select("id,input,status,created_at,output,error_code,current_stage")
        .eq("user_id", session.user.id)
        .eq("job_type", "video_generation")
        .order("created_at", { ascending: false });
      if (!active) return;
      if (error || !data) {
        setJobs(localJobs);
        setJobsOwnerId(session.user.id);
        return;
      }
      const remoteJobs: Job[] = data.map((row: any) => ({
        id: row.id,
        topic: String(row.input?.topic ?? "Untitled project"),
        language: String(row.input?.language ?? "Tamil"),
        createdAt: new Date(row.created_at).toLocaleString(),
        status: jobStatusLabel(row),
        story: typeof row.output?.story === "string" ? row.output.story : undefined,
        description: typeof row.input?.description === "string" ? row.input.description : undefined,
        aspectRatio: typeof row.input?.aspect_ratio === "string" ? row.input.aspect_ratio : undefined,
        captionsEnabled: typeof row.input?.captions_enabled === "boolean" ? row.input.captions_enabled : undefined,
        renderPath: typeof row.output?.render?.video_path === "string" ? row.output.render.video_path : undefined,
        thumbnailPath: typeof row.output?.render?.thumbnail_path === "string" ? row.output.render.thumbnail_path : undefined,
        captionsPath: typeof row.output?.render?.captions_path === "string" ? row.output.render.captions_path : undefined,
        renderDuration: typeof row.output?.render?.duration_seconds === "number" ? row.output.render.duration_seconds : undefined,
        renderMode: typeof row.output?.render?.visual_mode === "string" ? row.output.render.visual_mode : undefined,
        generatedImageCount: typeof row.output?.render?.generated_image_count === "number" ? row.output.render.generated_image_count : undefined,
        sceneAssetCount: typeof row.output?.render?.scene_asset_count === "number" ? row.output.render.scene_asset_count : undefined,
        hasNarration: row.output?.render?.audio === true,
        youtubeVideoId: typeof row.output?.render?.youtube_video_id === "string" ? row.output.render.youtube_video_id : undefined
      }));
      const merged = [...remoteJobs, ...localJobs.filter(local => !remoteJobs.some(remote => remote.id === local.id))];
      if (active) {
        setJobs(merged);
        setJobsOwnerId(session.user.id);
      }
      const { data: stages } = await supabase.from("job_stages")
        .select("job_id,stage_key,stage_order,status,selected_provider,error_message")
        .eq("user_id", session.user.id)
        .order("stage_order", { ascending: true });
      if (active && stages) {
        const grouped: Record<string, PipelineStage[]> = {};
        for (const stage of stages as PipelineStage[]) (grouped[stage.job_id] ??= []).push(stage);
        setJobStages(grouped);
      }
    })().catch(() => {
      if (active) {
        setJobs(localJobsFallback);
        setJobsOwnerId(session.user.id);
        Alert.alert("Cloud sync issue", "RJ could not load your saved projects. Your phone data remains safe.");
      }
    });
    return () => { active = false; };
  }, [session, dataLoaded, authReady]);

  useEffect(() => {
    if (!session || !supabase) return;
    const client = supabase;
    let active = true;
    client.rpc("rj_provider_status").then(({ data, error }) => {
      if (!active || error || !data) return;
      const next: Record<string, boolean> = {};
      for (const item of data as { provider: string; configured: boolean }[]) next[item.provider] = item.configured;
      setProviderStatus(next);
    });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (!session || !supabase) return;
    const client = supabase;
    let active = true;
    const refreshJobs = async () => {
      const { data, error } = await client.from("jobs")
        .select("id,input,status,created_at,output,error_code,current_stage")
        .eq("user_id", session.user.id)
        .eq("job_type", "video_generation")
        .order("created_at", { ascending: false });
      if (!active || error || !data) return;
      const remoteJobs: Job[] = data.map((row: any) => ({
        id: row.id,
        topic: String(row.input?.topic ?? "Untitled project"),
        language: String(row.input?.language ?? "Tamil"),
        createdAt: new Date(row.created_at).toLocaleString(),
        status: jobStatusLabel(row),
        story: typeof row.output?.story === "string" ? row.output.story : undefined,
        description: typeof row.input?.description === "string" ? row.input.description : undefined,
        aspectRatio: typeof row.input?.aspect_ratio === "string" ? row.input.aspect_ratio : undefined,
        captionsEnabled: typeof row.input?.captions_enabled === "boolean" ? row.input.captions_enabled : undefined,
        renderPath: typeof row.output?.render?.video_path === "string" ? row.output.render.video_path : undefined,
        thumbnailPath: typeof row.output?.render?.thumbnail_path === "string" ? row.output.render.thumbnail_path : undefined,
        captionsPath: typeof row.output?.render?.captions_path === "string" ? row.output.render.captions_path : undefined,
        renderDuration: typeof row.output?.render?.duration_seconds === "number" ? row.output.render.duration_seconds : undefined,
        renderMode: typeof row.output?.render?.visual_mode === "string" ? row.output.render.visual_mode : undefined
      }));
      setJobs(remoteJobs);
      setJobsOwnerId(session.user.id);
      const { data: stages } = await client.from("job_stages")
        .select("job_id,stage_key,stage_order,status,selected_provider,error_message")
        .eq("user_id", session.user.id)
        .order("stage_order", { ascending: true });
      if (active && stages) {
        const grouped: Record<string, PipelineStage[]> = {};
        for (const stage of stages as PipelineStage[]) (grouped[stage.job_id] ??= []).push(stage);
        setJobStages(grouped);
      }
    };
    const interval = setInterval(refreshJobs, 20000);
    return () => { active = false; clearInterval(interval); };
  }, [session]);

  useEffect(() => {
    if (Platform.OS === "web") {
      // Browser demo: device PIN and biometrics are native-only features.
      setPinConfigured(false);
      setPasswordConfigured(false);
      setLocked(false);
      setBiometricAvailable(false);
      setBiometricEnabled(false);
      AsyncStorage.getItem("rj_reminders").then(saved => {
        if (saved) setReminders(JSON.parse(saved) as Reminder[]);
      }).catch(() => undefined).finally(() => setDataLoaded(true));
      return;
    }
    (async () => {
      const savedReminders = await AsyncStorage.getItem("rj_reminders");
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
    if (!dataLoaded || !authReady) return;
    const writes: [string, string][] = [["rj_reminders", JSON.stringify(reminders)]];
    if (session && jobsOwnerId === session.user.id) writes.push(["rj_video_jobs_" + session.user.id, JSON.stringify(jobs)]);
    else if (!session && jobsOwnerId === "local") writes.push(["rj_video_jobs_local", JSON.stringify(jobs)]);
    AsyncStorage.multiSet(writes).catch(() => Alert.alert("Storage issue", "RJ could not save local project data."));
  }, [jobs, reminders, dataLoaded, authReady, session, jobsOwnerId]);

  useEffect(() => {
    if (!session || !supabase) { setAgentPermissions({}); return; }
    let active = true;
    supabase.functions.invoke("rj-agent-actions", { body: { action: "list" } }).then(({ data, error }) => {
      if (!active || error || !Array.isArray(data?.permissions)) return;
      const next: Record<string, boolean> = {};
      for (const item of data.permissions) next[item.tool_key] = item.enabled === true;
      setAgentPermissions(next);
    });
    return () => { active = false; };
  }, [session]);

  const setAgentToolPermission = async (toolKey: AgentToolKey, enabled: boolean) => {
    if (!supabase || !session || agentPermissionBusy) return;
    setAgentPermissionBusy(toolKey);
    try {
      const { data, error } = await supabase.functions.invoke("rj-agent-actions", {
        body: { action: "set_permission", tool_key: toolKey, enabled },
      });
      if (error || !data?.ok) throw error ?? new Error(data?.error ?? "Permission update failed.");
      setAgentPermissions(current => ({ ...current, [toolKey]: enabled }));
      Alert.alert("RJ permission updated", enabled ? "This tool is enabled. RJ will still ask before each action." : "This tool is disabled.");
    } catch (error: any) {
      Alert.alert("Permission update failed", error?.message ?? "Could not update RJ permission.");
    } finally { setAgentPermissionBusy(null); }
  };

  const beginAgentAction = async (toolKey: AgentToolKey, args: Record<string, string>): Promise<string> => {
    if (!supabase || !session) throw new Error("Sign in to enable audited RJ actions.");
    const { data, error } = await supabase.functions.invoke("rj-agent-actions", {
      body: { action: "begin_action", tool_key: toolKey, arguments: args, confirmed: true },
    });
    if (error || !data?.ok || !data?.request_id) throw new Error(data?.error ?? error?.message ?? "RJ permission check failed. No action was run.");
    return String(data.request_id);
  };

  const finishAgentAction = async (requestId: string, status: "succeeded" | "failed", summary: string) => {
    if (!supabase) throw new Error("RJ cloud connection is unavailable for audit completion.");
    const { data, error } = await supabase.functions.invoke("rj-agent-actions", {
      body: { action: "finish_action", request_id: requestId, status, result_summary: summary },
    });
    if (error || !data?.ok) throw new Error(data?.error ?? error?.message ?? "RJ could not complete the action audit.");
  };

  const uploadYoutubeFromChat = async (jobId: string): Promise<string> => {
    if (!supabase) throw new Error("RJ cloud connection is unavailable.");
    const job = jobs.find(item => item.id === jobId && !!item.renderPath && !item.youtubeVideoId);
    if (!job) throw new Error("இந்த project-க்கு rendered video இல்லை அல்லது ஏற்கெனவே upload செய்யப்பட்டுள்ளது.");
    setYoutubeUploadingJobId(jobId);
    try {
      const { data, error } = await supabase.functions.invoke("rj-youtube-publish", { body: { job_id: jobId } });
      if (error || !data?.ok) throw new Error(data?.error ?? error?.message ?? "YouTube upload failed.");
      const videoId = String(data.video_id);
      setJobs(current => current.map(item => item.id === jobId ? { ...item, youtubeVideoId: videoId } : item));
      return "YouTube upload முடிந்தது. Video PRIVATE-ஆக upload செய்யப்பட்டது: https://www.youtube.com/watch?v=" + videoId;
    } finally {
      setYoutubeUploadingJobId(null);
    }
  };

  const approveYoutubeUpload = (job: Job) => {
    Alert.alert(
      "Approve YouTube upload?",
      "RJ will upload this rendered kids video to your connected YouTube channel as PRIVATE. It will not be public. This uses one daily upload slot.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Approve & upload privately", onPress: async () => {
          try {
            await beginAgentAction("youtube.upload", { job_id: job.id });
            setYoutubeUploadingJobId(job.id);
            const { data, error } = await supabase!.functions.invoke("rj-youtube-publish", { body: { job_id: job.id } });
            if (error || !data?.ok) throw new Error(data?.error ?? error?.message ?? "YouTube upload failed.");
            setJobs(current => current.map(item => item.id === job.id ? { ...item, youtubeVideoId: String(data.video_id) } : item));
            Alert.alert("YouTube upload complete", "Video uploaded as PRIVATE. Open YouTube Studio to review it before making it public.");

          } catch (error: any) {
            Alert.alert("Upload not completed", error?.message ?? "Enable YouTube upload permission and connect a channel first.");
          } finally { setYoutubeUploadingJobId(null); }
        } }
      ]
    );
  };

  const createJob = async (requestedTopic?: string, requestedLanguage?: string): Promise<string> => {
    const clean = (requestedTopic ?? topic).trim();
    const projectLanguage = requestedLanguage ?? language;
    if (!clean) {
      Alert.alert("Topic needed", "Enter a video heading or story topic first.");
      return "தலைப்பு இல்லை. Video topic கொடுத்துவிட்டு மீண்டும் முயற்சி செய்யுங்கள்.";
    }
    if (session && jobsOwnerId !== session.user.id) {
      Alert.alert("Projects loading", "Wait a moment for your account projects to finish syncing, then try again.");
      return "Projects இன்னும் sync ஆகிறது. சிறிது நேரம் கழித்து மீண்டும் முயற்சி செய்யுங்கள்.";
    }
    const cloudQueueAvailable = !!(session && supabase);
    const item: Job = {
      id: String(Date.now()),
      topic: clean,
      language: projectLanguage,
      createdAt: new Date().toLocaleString(),
      status: cloudQueueAvailable ? "Queued — RJ worker will check providers" : "Saved on this phone — sign in to send to RJ worker"
    };
    if (session && supabase) {
      const { data, error } = await supabase.from("jobs").insert({
        user_id: session.user.id,
        job_type: "video_generation",
        status: "queued",
        idempotency_key: "video_generation:" + session.user.id + ":" + Date.now().toString(),
        input: { topic: clean, language: projectLanguage, stage: "queued" }
      }).select("id").single();
      if (data?.id) item.id = data.id;
      if (error) {
        Alert.alert("Cloud queue issue", "RJ could not send this project to the cloud worker. Please check your connection and try again.");
        return "Cloud queue-க்கு project அனுப்ப முடியவில்லை. Internet connection சரிபார்த்து மீண்டும் முயற்சி செய்யுங்கள்.";
      }
    }
    if (!cloudQueueAvailable) setJobsOwnerId("local");
    setJobs(current => [item, ...current]);
    setTopic("");
    if (cloudQueueAvailable) {
      Alert.alert("Added to RJ queue", "Your story request is safely queued. If no AI provider key is configured yet, RJ will pause it without losing the job.");
      setTab("Create");
      return "Video project RJ cloud queue-ல் சேர்க்கப்பட்டது. இது இன்னும் rendered video அல்ல; முதலில் story generation நடக்கும்.";
    }
    Alert.alert("Saved on this phone", "This is a local draft only. Sign in to RJ to send it to the cloud worker.");
    setTab("Create");
    return "Video project இந்த phone-ல் local draft ஆக save செய்யப்பட்டது. Cloud worker-க்கு அனுப்ப sign in செய்ய வேண்டும்.";
  };

  const submitAuth = async () => {
    if (!supabase) {
      Alert.alert("Connection unavailable", "RJ cloud connection is not configured in this build.");
      return;
    }
    const email = authEmail.trim().toLowerCase();
    if (!email || !authPassword) {
      Alert.alert("Details needed", "Enter your email and password.");
      return;
    }
    if (authMode === "signup" && authPassword.length < 8) {
      Alert.alert("Password too short", "Use at least 8 characters.");
      return;
    }
    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password: authPassword });
        if (error) throw error;
        if (data.session) {
          setAuthPassword("");
          setOtpPending(false);
        } else {
          setOtpPending(true);
          setAuthOtp("");
          Alert.alert("Verification code sent", "Enter the 6-digit code sent to your email.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
        if (error) {
          if (error.message.toLowerCase().includes("email not confirmed")) {
            setOtpPending(true);
            Alert.alert("Email verification needed", "Send a new 6-digit code to your email, then enter it here.");
          } else {
            throw error;
          }
        } else {
          setAuthPassword("");
          setOtpPending(false);
        }
      }
    } catch (error: any) {
      Alert.alert("Account issue", error?.message ?? "Could not complete account sign-in.");
    } finally {
      setAuthBusy(false);
    }
  };

  const verifyAuthOtp = async () => {
    if (!supabase) return;
    const email = authEmail.trim().toLowerCase();
    const token = authOtp.trim();
    if (!email || !/^\d{6}$/.test(token)) {
      Alert.alert("Code needed", "Enter the 6-digit code sent to your email.");
      return;
    }
    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({ email, token, type: "signup" });
      if (error) throw error;
      setAuthOtp("");
      setAuthPassword("");
      setOtpPending(false);
    } catch (error: any) {
      Alert.alert("Verification failed", error?.message ?? "That code could not be verified. Request a new code and try again.");
    } finally {
      setAuthBusy(false);
    }
  };

  const resendAuthOtp = async () => {
    if (!supabase) return;
    const email = authEmail.trim().toLowerCase();
    if (!email) {
      Alert.alert("Email needed", "Enter your email address first.");
      return;
    }
    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email });
      if (error) throw error;
      Alert.alert("New code sent", "Check your inbox and spam folder for the 6-digit RJ verification code.");
    } catch (error: any) {
      Alert.alert("Could not resend code", error?.message ?? "Please wait a moment and try again.");
    } finally {
      setAuthBusy(false);
    }
  };

  const saveProviderKey = async (provider: "gemini" | "openrouter" | "groq" | "cloudflare", value: string) => {
    if (!supabase || !session) return;
    const apiKey = value.trim();
    if (apiKey.length < 20) {
      Alert.alert("API key needed", "Paste the complete provider API key.");
      return;
    }
    setProviderBusy(provider);
    try {
      const { error } = await supabase.rpc("rj_store_provider_key", {
        p_provider: provider,
        p_api_key: apiKey,
      });
      if (error) throw error;
      setProviderStatus(current => ({ ...current, [provider]: true }));
      if (provider === "gemini") setGeminiKeyInput("");
      else if (provider === "openrouter") setOpenRouterKeyInput("");
      else if (provider === "groq") setGroqKeyInput("");
      else { setCloudflareAccountInput(""); setCloudflareTokenInput(""); setCloudflareFreePlanConfirmed(false); }
      Alert.alert("Provider saved securely", "The key is encrypted in RJ's backend. Any jobs waiting for a provider will be resumed automatically.");
    } catch (error: any) {
      Alert.alert("Could not save provider", error?.message ?? "RJ could not securely store this API key.");
    } finally {
      setProviderBusy(null);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) Alert.alert("Sign-out issue", error.message);
  };

  const saveProjectEdits = async (id: string, nextTopic: string, nextStory: string, description: string, aspectRatio: string, captionsEnabled: boolean) => {
    const existing = jobs.find(job => job.id === id);
    setJobs(current => current.map(job => job.id === id
      ? { ...job, topic: nextTopic, story: nextStory, description, aspectRatio, captionsEnabled, status: "Edits saved — render provider not connected" }
      : job));
    if (session && supabase && existing && /^[0-9a-f-]{36}$/i.test(id)) {
      const { error } = await supabase.rpc("rj_update_video_project", {
        p_job_id: id,
        p_topic: nextTopic,
        p_story: nextStory,
        p_description: description,
        p_aspect_ratio: aspectRatio,
        p_captions_enabled: captionsEnabled,
      });
      if (error) {
        Alert.alert("Cloud save issue", "Your edits are saved on this phone, but cloud sync failed: " + error.message);
      }
    }
  };

  const addReminder = async (requestedTitle?: string, requestedTime?: string): Promise<string> => {
    const title = (requestedTitle ?? scheduleTitle).trim();
    const reminderTime = requestedTime ?? scheduleTime;
    if (!title) {
      Alert.alert("Reminder needed", "Enter what you want RJ to remind you about.");
      return "Reminder title இல்லை. என்ன நினைவூட்ட வேண்டும் என்று சொல்லுங்கள்.";
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
      Alert.alert("Time not valid", "Use 24-hour format, for example 18:30.");
      return "நேரம் சரியில்லை. 24-hour format-ல் 18:30 போல கொடுங்கள்.";
    }
    let notificationId: string | null = null;
    if (Platform.OS !== "web") {
      try {
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("rj-reminders", {
            name: "RJ reminders", importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250], lightColor: RED
          });
        }
        const current = await Notifications.getPermissionsAsync();
        const permission = current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
        if (permission.status === "granted") {
          const [hour, minute] = reminderTime.split(":").map(Number);
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
    }
    const item: Reminder = { id: String(Date.now()), title, time: reminderTime, notificationId };
    setReminders(current => [item, ...current]);
    setScheduleTitle("");
    Alert.alert("Reminder saved", notificationId ? "RJ will notify you at the selected time." : "Saved in RJ. Allow notifications in Android settings to receive an alert.");
    return notificationId ? "Reminder save செய்யப்பட்டது. Android notification schedule-மும் அமைக்கப்பட்டது." : "Reminder RJ-ல் save செய்யப்பட்டது. Notification permission இல்லாததால் alert schedule ஆகவில்லை.";
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


  const connectYoutube = async () => {
    if (!supabase || !session) { Alert.alert("Sign in required", "Sign in to RJ before connecting YouTube."); return; }
    setYoutubeBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("rj-youtube-oauth", { body: { action: "start" } });
      if (error || !data?.authorization_url) throw new Error(data?.error ?? error?.message ?? "Could not start YouTube OAuth.");
      await Linking.openURL(data.authorization_url);
    } catch (error: any) {
      Alert.alert("YouTube setup unavailable", error?.message ?? "Could not start YouTube connection.");
    } finally { setYoutubeBusy(false); }
  };

  const renderHome = () => (
    <>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>PERSONAL AI WORKSPACE</Text>
        <Text style={styles.heroTitle}>Hello! <Text style={{ color: RED }}>RJ</Text></Text>
        <Text style={styles.heroSub}>உங்கள் அடுத்த வேலையைச் சொல்லுங்கள்.</Text>
        <Text style={styles.heroSub}>Tell RJ what you want to get done today.</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={() => setTab("Chat")} style={styles.chatLaunch}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>RJ CENTRAL BRAIN</Text>
          <Text style={styles.sectionTitle}>Talk to RJ</Text>
          <Text style={styles.muted}>தமிழ் • Tanglish • English — Chat with your AI assistant</Text>
        </View>
        <Text style={styles.chatLaunchArrow}>→</Text>
      </Pressable>
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
      <Text style={styles.note}>Only this topic field is sent to story generation. Include character names, animal types, plot details and duration here; chat history and older projects are not copied into a new project.</Text>
      <Text style={styles.fieldLabel}>Video language</Text>
      <View style={styles.choiceRow}>
        {["Tamil", "Tanglish", "English"].map(item => (
          <Pressable key={item} onPress={() => setLanguage(item)} style={[styles.choice, language === item && styles.choiceActive]}>
            <Text style={[styles.choiceText, language === item && { color: "#FFFFFF" }]}>{item}</Text>
          </Pressable>
        ))}
      </View>
      <ActionButton title="Queue story generation" onPress={createJob} />
      <Text style={styles.note}>Story generation runs through RJ’s background queue using OpenRouter Free first and Groq Free as automatic fallback. Voice-over, visuals, subtitles, rendering and YouTube publishing are still separate stages.</Text>
      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Your video projects</Text>
      {jobs.length === 0 ? <Text style={styles.muted}>No projects yet. Add your first topic above.</Text> : jobs.map(job => (
        <View key={job.id} style={styles.jobCard}>
          <Text style={styles.jobTitle}>{job.topic}</Text>
          <Text style={styles.muted}>{job.language} • {job.createdAt}</Text>
          <Text style={styles.jobStatus}>{job.status}</Text>
          {job.renderPath ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.muted}>
                {job.renderDuration ? Math.round(job.renderDuration) + " sec" : "Rendered"} • {job.generatedImageCount ? job.generatedImageCount + " AI images" : "Local scene artwork"} • {job.sceneAssetCount ? job.sceneAssetCount + " saved scene images" : "No saved scene assets"} • Ken Burns motion • {job.hasNarration ? "Tamil narration" : "No narration"}
              </Text>
              {job.youtubeVideoId ? (
                <Pressable onPress={() => Linking.openURL("https://www.youtube.com/watch?v=" + job.youtubeVideoId)}>
                  <Text style={{ color: "#53C98B", marginTop: 8, fontWeight: "700" }}>Uploaded privately — open YouTube video</Text>
                </Pressable>
              ) : session ? (
                <ActionButton title={youtubeUploadingJobId === job.id ? "Uploading to YouTube…" : "Approve & upload privately to YouTube"} onPress={() => approveYoutubeUpload(job)} secondary disabled={youtubeUploadingJobId !== null} />
              ) : null}
              <Pressable onPress={async () => {
                if (!supabase) return;
                const { data, error } = await supabase.storage.from("rj-renders").createSignedUrl(job.renderPath!, 3600);
                if (error || !data?.signedUrl) {
                  Alert.alert("Video unavailable", "RJ could not create a private playback link. Check that the render storage migration is deployed.");
                  return;
                }
                await Linking.openURL(data.signedUrl);
              }}>
                <Text style={{ color: RED, marginTop: 8, fontWeight: "700" }}>Play rendered video</Text>
              </Pressable>
              {job.captionsPath ? (
                <Pressable onPress={async () => {
                  if (!supabase) return;
                  const { data, error } = await supabase.storage.from("rj-renders").createSignedUrl(job.captionsPath!, 3600);
                  if (error || !data?.signedUrl) {
                    Alert.alert("Captions unavailable", "RJ could not create a private captions link.");
                    return;
                  }
                  await Linking.openURL(data.signedUrl);
                }}>
                  <Text style={{ color: RED, marginTop: 8 }}>Open captions (SRT)</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {jobStages[job.id]?.length ? (
            <View style={{ marginTop: 10, paddingTop: 9, borderTopWidth: 1, borderTopColor: "#383838" }}>
              <Text style={styles.muted}>Pipeline: {jobStages[job.id].filter(stage => stage.status === "succeeded").length}/11 stages complete</Text>
              {jobStages[job.id].filter(stage => ["running", "blocked", "failed", "waiting_retry"].includes(stage.status)).map(stage => (
                <Text key={stage.stage_key} style={[styles.muted, { color: stage.status === "blocked" || stage.status === "failed" ? "#F0A23A" : "#E2E2E2", marginTop: 4 }]}>
                  {PIPELINE_STAGE_LABELS[stage.stage_key] ?? stage.stage_key}: {stage.status === "blocked" ? "Waiting for required provider" : stage.status === "failed" ? "Needs attention" : stage.status === "waiting_retry" ? "Retry scheduled" : "In progress"}
                </Text>
              ))}
            </View>
          ) : null}
          {job.story ? (
            <>
              <Text style={styles.muted}>{expandedJobId === job.id ? job.story : job.story.slice(0, 420) + (job.story.length > 420 ? "…" : "")}</Text>
              {job.story.length > 420 ? (
                <Pressable onPress={() => setExpandedJobId(current => current === job.id ? null : job.id)}>
                  <Text style={{ color: RED, marginTop: 8 }}>{expandedJobId === job.id ? "Collapse story" : "Read full story"}</Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
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
      <Text style={styles.note}>{Platform.OS === "web" ? "Browser demo: reminders are saved locally for testing; browser notifications are not enabled here." : "RJ schedules local Android notifications. Delivery time can still be affected by Android battery and alarm settings."}</Text>
      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Saved reminders</Text>
      {reminders.length === 0 ? <Text style={styles.muted}>Nothing scheduled yet.</Text> : reminders.map(r => <Text key={r.id} style={styles.listLine}>• {r.title} • {r.time}</Text>)}
    </View>
  );

  const renderSettings = () => (
    <>
      {Platform.OS !== "web" ? <View style={styles.panel}>
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
      </View> : <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Device security</Text>
        <Text style={styles.muted}>PIN, password and biometric settings are tested on the Android Main App. They are intentionally unavailable in this browser-only demo.</Text>
      </View>}
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>AI Agent permissions</Text>
        <Text style={styles.muted}>ஒவ்வொரு tool-ஐயும் இங்கே enable செய்ய வேண்டும். Enable செய்தாலும் RJ ஒவ்வொரு செயலுக்கும் Confirm கேட்கும்.</Text>
        {([
          ["video.create", "Create video project"],
          ["reminder.create", "Save reminder"],
          ["navigation.open", "Open app screens"],
          ["youtube.upload", "Upload approved video privately to YouTube"],
        ] as [AgentToolKey, string][]).map(([key, label]) => (
          <View key={key} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9 }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={styles.listLine}>{label}</Text>
              <Text style={styles.muted}>{agentPermissions[key] ? "Enabled · confirmation required" : "Disabled"}</Text>
            </View>
            <ActionButton title={agentPermissionBusy === key ? "Saving…" : agentPermissions[key] ? "Disable" : "Enable"} onPress={() => setAgentToolPermission(key, !agentPermissions[key])} disabled={agentPermissionBusy !== null} secondary={!agentPermissions[key]} />
          </View>
        ))}
        <Text style={styles.note}>Every confirmed action is checked by the server and written to the audit log. New tools stay disabled until you enable them.</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>RJ account</Text>
        <Text style={styles.muted}>Signed in as {session?.user?.email ?? "Unknown account"}</Text>
        <ActionButton title="Sign out of RJ" onPress={signOut} secondary />
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>AI providers & spending policy</Text>
        <Text style={styles.listLine}>Gemini: <Text style={providerStatus.gemini ? { color: "#53C98B", fontWeight: "700" } : styles.pending}>{providerStatus.gemini ? "Key stored securely" : "Not connected"}</Text></Text>
        <Pressable onPress={() => Linking.openURL("https://aistudio.google.com/apikey")}><Text style={{ color: RED, marginBottom: 10 }}>Get a free Gemini API key ↗</Text></Pressable>
        <Field label="Gemini API key" value={geminiKeyInput} onChangeText={setGeminiKeyInput} placeholder="Paste Gemini API key" secureTextEntry />
        <ActionButton title={providerBusy === "gemini" ? "Saving…" : "Save Gemini key"} onPress={() => saveProviderKey("gemini", geminiKeyInput)} disabled={providerBusy !== null} />
        <View style={styles.divider} />
        <Text style={styles.listLine}>OpenRouter: <Text style={providerStatus.openrouter ? { color: "#53C98B", fontWeight: "700" } : styles.pending}>{providerStatus.openrouter ? "Key stored securely" : "Not connected"}</Text></Text>
        <Pressable onPress={() => Linking.openURL("https://openrouter.ai/settings/keys")}><Text style={{ color: RED, marginBottom: 10 }}>Get an OpenRouter API key ↗</Text></Pressable>
        <Field label="OpenRouter API key" value={openRouterKeyInput} onChangeText={setOpenRouterKeyInput} placeholder="Paste OpenRouter API key" secureTextEntry />
        <ActionButton title={providerBusy === "openrouter" ? "Saving…" : "Save OpenRouter key"} onPress={() => saveProviderKey("openrouter", openRouterKeyInput)} disabled={providerBusy !== null} />
        <View style={styles.divider} />
        <Text style={styles.listLine}>Groq Free: <Text style={providerStatus.groq ? { color: "#53C98B", fontWeight: "700" } : styles.pending}>{providerStatus.groq ? "Key stored securely" : "Not connected"}</Text></Text>
        <Pressable onPress={() => Linking.openURL("https://console.groq.com/keys")}><Text style={{ color: RED, marginBottom: 10 }}>Get a Groq API key ↗</Text></Pressable>
        <Field label="Groq Free API key" value={groqKeyInput} onChangeText={setGroqKeyInput} placeholder="Paste Groq API key" secureTextEntry />
        <ActionButton title={providerBusy === "groq" ? "Saving…" : "Save Groq Free key"} onPress={() => saveProviderKey("groq", groqKeyInput)} disabled={providerBusy !== null} />
        <View style={styles.divider} />
        <Text style={styles.listLine}>Cloudflare Workers AI Free: <Text style={providerStatus.cloudflare ? { color: "#53C98B", fontWeight: "700" } : styles.pending}>{providerStatus.cloudflare ? "Credentials stored securely" : "Not connected"}</Text></Text>
        <Pressable onPress={() => Linking.openURL("https://dash.cloudflare.com/profile/api-tokens")}><Text style={{ color: RED, marginBottom: 10 }}>Create a Cloudflare API token ↗</Text></Pressable>
        <Field label="Cloudflare Account ID" value={cloudflareAccountInput} onChangeText={setCloudflareAccountInput} placeholder="Account ID" secureTextEntry />
        <Field label="Cloudflare API token (Workers AI:Read)" value={cloudflareTokenInput} onChangeText={setCloudflareTokenInput} placeholder="Paste scoped API token" secureTextEntry />
        <Pressable onPress={() => setCloudflareFreePlanConfirmed(value => !value)} style={{ paddingVertical: 10 }}>
          <Text style={styles.listLine}>{cloudflareFreePlanConfirmed ? "☑" : "☐"} I confirm this Cloudflare account is on the Workers Free plan (not Workers Paid).</Text>
        </Pressable>
        <ActionButton title={providerBusy === "cloudflare" ? "Saving…" : "Save Cloudflare Free credentials"} onPress={() => saveProviderKey("cloudflare", cloudflareAccountInput.trim() + ":" + cloudflareTokenInput.trim())} disabled={providerBusy !== null || !cloudflareFreePlanConfirmed || cloudflareAccountInput.trim().length < 20 || cloudflareTokenInput.trim().length < 20} />
        <Text style={styles.note}>IMPORTANT: Only connect this on Cloudflare Workers Free plan. Workers AI has 10,000 free Neurons/day there and hard-stops after the limit. Workers Paid accounts can be charged above the free quota; RJ will not use them. Keys are encrypted in Supabase Vault. If image quota is exhausted, RJ uses free local vector artwork.</Text>
                <Text style={styles.note}>Keys are encrypted in Supabase Vault and never saved in the app or GitHub. RJ uses OpenRouter Free, then Groq Free for text; optional Cloudflare Workers AI is only for a confirmed Workers Free account. Tamil narration runs locally with Piper. Paid providers remain disabled.</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Other connections</Text>
        <Text style={styles.listLine}>YouTube account: <Text style={youtubeConnection === "connected" ? { color: "#53C98B", fontWeight: "700" } : styles.pending}>{youtubeConnection === "connected" ? (youtubeChannelTitle ?? "Connected") : "Not connected"}</Text></Text>
        <ActionButton title={youtubeBusy ? "Opening Google…" : youtubeConnection === "connected" ? "Connect another YouTube channel" : "Connect YouTube channel"} onPress={connectYoutube} disabled={youtubeBusy || !session} />
        <Text style={styles.listLine}>Cloud sync: <Text style={{ color: "#53C98B", fontWeight: "700" }}>Connected</Text></Text>
        <Text style={styles.note}>YouTube OAuth, multi-channel publishing and scheduling are the remaining major pipeline stages.</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>About RJ</Text>
        <Text style={styles.muted}>Personal Android assistant • Black + Red • Tamil / Tanglish / English</Text>
        <Text style={styles.muted}>Version 1.0.0 — foundation build</Text>
      </View>
    </>
  );

  if (!dataLoaded || !authReady) {
    return <View style={[styles.screen, styles.lockScreen]}><StatusBar style="light" /><Text style={styles.brand}>RJ<Text style={{ color: RED }}>.</Text></Text><Text style={styles.muted}>Loading your secure workspace…</Text></View>;
  }

  if (!session && otpPending) {
    return (
      <View style={[styles.screen, styles.lockScreen]}>
        <StatusBar style="light" />
        <Text style={styles.brand}>RJ<Text style={{ color: RED }}>.</Text></Text>
        <Text style={styles.heroSub}>Verify your email</Text>
        <Text style={styles.muted}>Enter the 6-digit code sent to {authEmail.trim().toLowerCase()}.</Text>
        <Field label="6-digit verification code" value={authOtp} onChangeText={setAuthOtp} placeholder="123456" />
        <ActionButton title={authBusy ? "Please wait…" : "Verify code"} onPress={verifyAuthOtp} disabled={authBusy} />
        <ActionButton title="Resend verification code" onPress={resendAuthOtp} secondary disabled={authBusy} />
        <ActionButton title="Back to sign in" onPress={() => { setOtpPending(false); setAuthOtp(""); setAuthMode("signin"); }} secondary disabled={authBusy} />
        <Text style={styles.note}>Use the latest code from your email. Never share this code with anyone.</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={[styles.screen, styles.lockScreen]}>
        <StatusBar style="light" />
        <Text style={styles.brand}>RJ<Text style={{ color: RED }}>.</Text></Text>
        <Text style={styles.heroSub}>Your private RJ account</Text>
        <Text style={styles.muted}>Sign in to sync your saved projects securely across your devices.</Text>
        <Field label="Email address" value={authEmail} onChangeText={setAuthEmail} placeholder="you@example.com" />
        <Field label="Password (minimum 8 characters)" value={authPassword} onChangeText={setAuthPassword} placeholder="Enter password" secureTextEntry />
        <ActionButton title={authBusy ? "Please wait…" : authMode === "signup" ? "Create RJ account" : "Sign in"} onPress={submitAuth} disabled={authBusy} />
        <ActionButton title={authMode === "signup" ? "Already have an account? Sign in" : "New to RJ? Create account"} onPress={() => setAuthMode(authMode === "signup" ? "signin" : "signup")} secondary disabled={authBusy} />
        <Text style={styles.note}>Your PIN, password and fingerprint lock remain local to this phone. Account password is handled by Supabase Auth.</Text>
      </View>
    );
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
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <StatusBar style="light" />
      {tab === "Chat" ? (
        <View style={styles.fullChatScreen}>
          <View style={styles.chatTopBar}>
            <Pressable accessibilityRole="button" onPress={() => setTab("Home")} style={styles.chatBackButton}>
              <Text style={styles.chatBackText}>‹  HOME</Text>
            </Pressable>
            <Text style={styles.chatTopTitle}>RJ AI CHAT</Text>
            <View style={{ width: 76 }} />
          </View>
          <AssistantScreen projects={jobs.filter(job => !!job.renderPath && !job.youtubeVideoId).map(job => ({ id: job.id, topic: job.topic, renderPath: job.renderPath, youtubeVideoId: job.youtubeVideoId }))} onUploadYoutube={uploadYoutubeFromChat} onCreateVideoProject={(value) => createJob(value, language)} onCreateReminder={addReminder} onNavigate={async (value) => { setTab(value as Tab); return value + " screen திறக்கப்பட்டது."; }} onBeginAgentAction={beginAgentAction} onFinishAgentAction={finishAgentAction} />
        </View>
      ) : (
        <>
          <View style={styles.header}>
            <View style={styles.headerBrandRow}>
              <Image source={require("./assets/rj-logo.jpg")} style={styles.brandLogo} resizeMode="cover" />
              <View>
                <Text style={styles.brand}>RJ<Text style={{ color: RED }}>.</Text></Text>
                <Text style={styles.headerCaption}>YOUR PERSONAL WORKSPACE</Text>
              </View>
            </View>
            <View style={styles.liveDot}><View style={styles.dot} /><Text style={styles.liveText}>READY</Text></View>
          </View>
          <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
            {tab === "Home" && renderHome()}
            {tab === "Create" && renderCreate()}
            {tab === "Edit" && <VideoEditorScreen projects={jobs} onSave={saveProjectEdits} />}
            {tab === "Tools" && <ToolHubScreen geminiConnected={!!providerStatus.gemini} openRouterConnected={!!providerStatus.openrouter} onOpenSettings={() => setTab("Settings")} />}
            {tab === "Schedule" && renderSchedule()}
            {tab === "Settings" && renderSettings()}
          </ScrollView>
          <View style={styles.tabBar}>
            {(["Home", "Create", "Edit", "Tools", "Schedule", "Settings"] as Tab[]).map(item => (
              <Pressable key={item} onPress={() => setTab(item)} style={styles.tabItem}>
                <Text style={[styles.tabIcon, tab === item && { color: RED }]}>{item === "Home" ? "⌂" : item === "Create" ? "＋" : item === "Edit" ? "✎" : item === "Tools" ? "◇" : item === "Schedule" ? "◷" : "⚙"}</Text>
                <Text style={[styles.tabLabel, tab === item && { color: "#FFFFFF" }]}>{item}</Text>
                {tab === item && <View style={styles.tabUnderline} />}
              </Pressable>
            ))}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  lockScreen: { justifyContent: "center", padding: 24 },
  header: { paddingTop: Platform.OS === "android" ? 18 : 54, paddingHorizontal: 22, paddingBottom: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#242424" },
  headerBrandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandLogo: { width: 46, height: 46, borderRadius: 12, backgroundColor: "#FFFFFF" },
  brand: { color: "#FFFFFF", fontSize: 30, fontWeight: "900", letterSpacing: 2 },
  headerCaption: { color: MUTED, fontSize: 9, letterSpacing: 2, marginTop: 2 },
  liveDot: { flexDirection: "row", alignItems: "center", backgroundColor: "#1A1A1A", borderRadius: 30, paddingHorizontal: 11, paddingVertical: 7, gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 5, backgroundColor: RED },
  liveText: { color: "#DDDDDD", fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 18 },
  fullChatScreen: { flex: 1, paddingTop: Platform.OS === "android" ? 4 : 10, paddingHorizontal: 12 },
  chatTopBar: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  chatBackButton: { minWidth: 76, minHeight: 40, justifyContent: "center" },
  chatBackText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  chatTopTitle: { color: "#A3A3A3", fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  chatLaunch: { flexDirection: "row", alignItems: "center", backgroundColor: PANEL, borderRadius: 16, borderWidth: 1, borderColor: "#393939", padding: 16, marginBottom: 16 },
  chatLaunchArrow: { color: RED, fontSize: 28, fontWeight: "700", marginLeft: 10 },
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