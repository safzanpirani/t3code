import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";

import { deepgramApiKey as buildTimeDeepgramApiKey } from "./deepgramKey";
import { normalizeDeepgramKey } from "./deepgramKeyFormat";

export { maskDeepgramKey, normalizeDeepgramKey } from "./deepgramKeyFormat";

const DEEPGRAM_KEY_STORAGE_KEY = "t3code.speech.deepgram-api-key";

type Listener = (key: string | undefined) => void;

const listeners = new Set<Listener>();
let cached: string | undefined;
let loaded = false;

function publish() {
  for (const listener of listeners) listener(cached);
}

async function load(): Promise<string | undefined> {
  if (loaded) return cached;
  try {
    const stored = await SecureStore.getItemAsync(DEEPGRAM_KEY_STORAGE_KEY);
    cached = stored ? normalizeDeepgramKey(stored) : undefined;
  } catch {
    // A locked or unavailable keystore is not a reason to lose the build-time
    // fallback; it only means nothing was saved on this device.
    cached = undefined;
  }
  loaded = true;
  return cached;
}

export async function saveDeepgramKey(value: string): Promise<void> {
  const normalized = normalizeDeepgramKey(value);
  cached = normalized;
  loaded = true;
  if (normalized === undefined) {
    await SecureStore.deleteItemAsync(DEEPGRAM_KEY_STORAGE_KEY);
  } else {
    await SecureStore.setItemAsync(DEEPGRAM_KEY_STORAGE_KEY, normalized);
  }
  publish();
}

export async function clearDeepgramKey(): Promise<void> {
  await saveDeepgramKey("");
}

/**
 * The key voice input should use: whatever the user saved on this device,
 * falling back to the build-time key so a build handed to someone with the key
 * baked in still works with no setup.
 *
 * `loading` is true only until the keystore read settles, so the composer does
 * not flash "unconfigured" on a device that does have a key.
 */
export function useDeepgramApiKey(): {
  readonly key: string | undefined;
  readonly stored: string | undefined;
  readonly loading: boolean;
} {
  const [stored, setStored] = useState<string | undefined>(() => (loaded ? cached : undefined));
  const [loading, setLoading] = useState(!loaded);

  useEffect(() => {
    let active = true;
    const listener: Listener = (next) => {
      if (active) setStored(next);
    };
    listeners.add(listener);
    void load().then((next) => {
      if (!active) return;
      setStored(next);
      setLoading(false);
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  return { key: stored ?? buildTimeDeepgramApiKey(), stored, loading };
}

export const useDeepgramKeyActions = () => {
  const save = useCallback((value: string) => saveDeepgramKey(value), []);
  const clear = useCallback(() => clearDeepgramKey(), []);
  return { save, clear };
};
