import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";

import { FluxSession, decodeBase64 } from "./fluxClient";
import { useDeepgramApiKey } from "./deepgramKeyStore";
import { nativeSpeech } from "./nativeSpeech";

export type VoiceInputState =
  | "unavailable"
  | "unconfigured"
  | "ready"
  | "recording"
  | "transcribing"
  | "error";

const MAX_RECORDING_MS = 120_000;

async function ensureMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: "Microphone access",
    message: "T3 Code needs the microphone to transcribe what you say.",
    buttonPositive: "Allow",
  });
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Voice input for the mobile composer. Microphone audio is streamed to
 * Deepgram Flux while the user speaks and the final transcript is handed back
 * once the server confirms the turn ended.
 */
export function useVoiceInput(onTranscript: (text: string) => void) {
  const { key: apiKey, loading: keyLoading } = useDeepgramApiKey();
  const supported = Platform.OS === "android" && nativeSpeech !== null;
  const [state, setState] = useState<VoiceInputState>(
    !supported ? "unavailable" : apiKey ? "ready" : "unconfigured",
  );
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const sessionRef = useRef<FluxSession | undefined>(undefined);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  // The saved key arrives asynchronously and can change while the composer is
  // mounted (the user pastes one in settings), so readiness follows it instead
  // of being decided once at mount. Idle states only: this must not interrupt a
  // recording in progress.
  useEffect(() => {
    if (!supported || keyLoading) return;
    setState((current) =>
      current === "ready" || current === "unconfigured"
        ? apiKey
          ? "ready"
          : "unconfigured"
        : current,
    );
  }, [apiKey, keyLoading, supported]);

  const teardown = useCallback(async () => {
    await nativeSpeech?.stop().catch(() => undefined);
    sessionRef.current?.dispose();
    sessionRef.current = undefined;
    setLevel(0);
  }, []);

  // Audio frames arrive on a native thread and are forwarded straight to the
  // socket; nothing is buffered on the JS side.
  useEffect(() => {
    if (!nativeSpeech) return;
    const audio = nativeSpeech.addListener("onAudio", (event) => {
      sessionRef.current?.push(decodeBase64(event.pcm));
    });
    const levels = nativeSpeech.addListener("onLevel", (event) => setLevel(event.level));
    const errors = nativeSpeech.addListener("onError", (event) => {
      setMessage(event.message);
      setState("error");
      void teardown();
    });
    return () => {
      audio.remove();
      levels.remove();
      errors.remove();
    };
  }, [teardown]);

  useEffect(() => {
    return () => {
      void teardown();
    };
  }, [teardown]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    setState("transcribing");
    setPartial("");
    try {
      await nativeSpeech?.stop();
      const text = (await session.finish()).trim();
      if (text) transcriptRef.current(text);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    } finally {
      sessionRef.current = undefined;
      setLevel(0);
    }
  }, []);

  const cancel = useCallback(async () => {
    await teardown();
    setPartial("");
    setState(apiKey ? "ready" : "unconfigured");
  }, [apiKey, teardown]);

  const start = useCallback(async () => {
    if (!supported || !nativeSpeech) return;
    if (!apiKey) {
      setState("unconfigured");
      return;
    }
    if (sessionRef.current) return;
    if (!(await ensureMicrophonePermission())) {
      setMessage("Microphone permission was denied.");
      setState("error");
      return;
    }

    setMessage(undefined);
    setPartial("");
    const session = new FluxSession({ apiKey, onPartial: setPartial });
    try {
      // The socket opens before capture starts so connection setup is not on
      // the path between speaking and seeing text.
      await session.begin();
      sessionRef.current = session;
      nativeSpeech.start();
      setState("recording");
    } catch (error) {
      session.dispose();
      sessionRef.current = undefined;
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    }
  }, [apiKey, supported]);

  // A runaway recording would stream audio (and bill) indefinitely.
  useEffect(() => {
    if (state !== "recording") return;
    const timer = setTimeout(() => void stop(), MAX_RECORDING_MS);
    return () => clearTimeout(timer);
  }, [state, stop]);

  return { supported, state, level, partial, message, start, stop, cancel };
}
