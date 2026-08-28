import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  clearDeepgramKey,
  maskDeepgramKey,
  normalizeDeepgramKey,
  saveDeepgramKey,
  useDeepgramApiKey,
} from "../speech/deepgramKeyStore";
import { SettingsSection } from "./components/SettingsSection";

/**
 * The phone streams microphone audio straight to Deepgram Flux, so the key
 * belongs on the device rather than in the build or on whichever server the app
 * happens to be connected to. Voice input then works against any t3code server.
 */
export function SettingsVoiceRouteScreen() {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("--color-foreground");
  const muted = useThemeColor("--color-foreground-muted");
  const border = useThemeColor("--color-border");
  const danger = useThemeColor("--color-danger-foreground");
  const { key, stored, loading } = useDeepgramApiKey();

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(undefined), 2_500);
    return () => clearTimeout(timer);
  }, [status]);

  const usingBuildKey = stored === undefined && key !== undefined;

  const save = async () => {
    if (normalizeDeepgramKey(draft) === undefined) return;
    setSaving(true);
    try {
      await saveDeepgramKey(draft);
      setDraft("");
      setStatus("Saved");
    } catch {
      setStatus("Could not save the key on this device");
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = () => {
    Alert.alert(
      "Remove the Deepgram key?",
      "Voice input stops working until another key is saved.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void clearDeepgramKey()
              .then(() => setStatus("Removed"))
              .catch(() => setStatus("Could not remove the key"));
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 20 }}
      keyboardShouldPersistTaps="handled"
    >
      <SettingsSection title="Deepgram">
        <View className="gap-3 p-4">
          <Text className="text-base text-foreground-muted">
            Voice input streams audio from this device straight to Deepgram Flux
            (flux-general-multi). The key is stored in the device keystore and never sent to a
            t3code server, so dictation works against any environment.
          </Text>

          {loading ? (
            <View className="flex-row items-center gap-2 py-2">
              <ActivityIndicator />
              <Text className="text-base text-foreground-muted">Checking saved key…</Text>
            </View>
          ) : (
            <Text className="text-base" style={{ color: key ? foreground : muted }}>
              {stored
                ? `Saved key ${maskDeepgramKey(stored)}`
                : usingBuildKey
                  ? "Using the key baked into this build"
                  : "No key saved — voice input is disabled"}
            </Text>
          )}

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Paste a Deepgram API key"
            placeholderTextColor={muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!saving}
            className="rounded-[14px] px-3 py-3 text-base"
            style={{ borderColor: border, borderWidth: 1, color: foreground }}
          />

          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save Deepgram key"
              disabled={saving || normalizeDeepgramKey(draft) === undefined}
              onPress={() => void save()}
              className="rounded-[14px] px-4 py-2.5"
              style={{
                borderColor: border,
                borderWidth: 1,
                opacity: normalizeDeepgramKey(draft) === undefined || saving ? 0.45 : 1,
              }}
            >
              <Text className="text-base font-t3-medium text-foreground">
                {saving ? "Saving…" : "Save"}
              </Text>
            </Pressable>

            {stored ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove Deepgram key"
                onPress={confirmRemove}
                className="rounded-[14px] px-4 py-2.5"
              >
                <Text className="text-base font-t3-medium" style={{ color: danger }}>
                  Remove
                </Text>
              </Pressable>
            ) : null}

            {status ? <Text className="text-base text-foreground-muted">{status}</Text> : null}
          </View>
        </View>
      </SettingsSection>
    </ScrollView>
  );
}
