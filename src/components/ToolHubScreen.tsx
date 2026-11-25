import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type ToolHubProps = {
  geminiConnected: boolean;
  openRouterConnected: boolean;
  onOpenSettings: () => void;
};

const RED = "#F3263D";

function ToolCard({ title, description, status, action, onPress, muted = false }: {
  title: string;
  description: string;
  status: string;
  action?: string;
  onPress?: () => void;
  muted?: boolean;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.title}>{title}</Text>
        <Text style={[styles.status, status === "Connected" ? styles.connected : muted ? styles.pending : styles.pending]}>{status}</Text>
      </View>
      <Text style={styles.description}>{description}</Text>
      {action && onPress ? (
        <Pressable accessibilityRole="button" onPress={onPress} style={styles.button}>
          <Text style={styles.buttonText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function ToolHubScreen({ geminiConnected, openRouterConnected, onOpenSettings }: ToolHubProps) {
  return (
    <View>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>RJ TOOL HUB</Text>
        <Text style={styles.heading}>Connect your tools</Text>
        <Text style={styles.intro}>RJ will use connected services inside your workspace. You stay in RJ while tasks run.</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AI brains</Text>
        <ToolCard
          title="Google Gemini"
          description="Text intelligence and supported Google AI capabilities. API key is stored securely by RJ."
          status={geminiConnected ? "Connected" : "Not connected"}
          action={geminiConnected ? "Manage connection" : "Connect Gemini"}
          onPress={onOpenSettings}
        />
        <ToolCard
          title="OpenRouter"
          description="Access compatible AI models through your own OpenRouter account. Free-model availability and quotas can change."
          status={openRouterConnected ? "Connected" : "Not connected"}
          action={openRouterConnected ? "Manage connection" : "Connect OpenRouter"}
          onPress={onOpenSettings}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Video creation</Text>
        <ToolCard
          title="Google video generation"
          description="RJ in-app video provider integration. The supported official Google API and account eligibility must be verified before enabling it. RJ will not send you out to the Flow website."
          status="Integration pending"
          muted
        />
        <ToolCard
          title="RJ Video Studio"
          description="Prompt → script → scenes → voice → subtitles → render → preview → YouTube. The full pipeline is being built in stages."
          status="Pipeline in development"
          muted
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Publishing & developer tools</Text>
        <ToolCard
          title="YouTube"
          description="Connect your Google account to upload or schedule videos from RJ after reviewing and approving the final video."
          status="OAuth not connected"
          muted
        />
        <ToolCard
          title="Coding tools / custom integrations"
          description="The Tool Hub is designed for additional API and MCP adapters. Each tool will be checked for supported actions and permissions before it can run."
          status="Connector framework pending"
          muted
        />
      </View>

      <Text style={styles.footer}>Security: connections must be authorized by you. Provider secrets stay server-side; paid actions and publishing require confirmation. RJ will never pretend an unsupported integration is connected.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { paddingVertical: 18, paddingHorizontal: 4 },
  eyebrow: { color: RED, fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  heading: { color: "#FFFFFF", fontSize: 25, fontWeight: "900", marginTop: 8 },
  intro: { color: "#A3A3A3", fontSize: 13, lineHeight: 20, marginTop: 8 },
  section: { marginBottom: 16 },
  sectionTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "800", marginBottom: 9 },
  card: { backgroundColor: "#151515", borderColor: "#292929", borderWidth: 1, borderRadius: 15, padding: 14, marginBottom: 9 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  title: { color: "#FFFFFF", fontSize: 14, fontWeight: "800", flex: 1 },
  status: { fontSize: 10, fontWeight: "800" },
  connected: { color: "#53C98B" },
  pending: { color: "#F0A23A" },
  description: { color: "#A3A3A3", fontSize: 12, lineHeight: 18, marginTop: 8 },
  button: { backgroundColor: "#292929", borderColor: RED, borderWidth: 1, borderRadius: 10, minHeight: 42, justifyContent: "center", alignItems: "center", marginTop: 12 },
  buttonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  footer: { color: "#858585", fontSize: 11, lineHeight: 17, marginTop: 2, marginBottom: 14 },
});
