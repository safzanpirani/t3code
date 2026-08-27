import { requireOptionalNativeModule } from "expo";

export type NativeSpeechEvents = {
  onAudio: (event: { pcm: string }) => void;
  onLevel: (event: { level: number; elapsedMs: number }) => void;
  onError: (event: { message: string }) => void;
};

export type NativeSpeechSubscription = { remove(): void };

export type NativeSpeech = {
  /** True once the microphone permission has actually been granted. */
  isAvailable(): boolean;
  start(): void;
  stop(): Promise<void>;
  addListener<Event extends keyof NativeSpeechEvents>(
    event: Event,
    listener: NativeSpeechEvents[Event],
  ): NativeSpeechSubscription;
};

/**
 * Android-only microphone capture. Optional because iOS has no implementation
 * yet, so callers must treat a missing module as "voice input unavailable"
 * rather than assuming it is there.
 */
export const nativeSpeech = requireOptionalNativeModule<NativeSpeech>("T3Speech");
