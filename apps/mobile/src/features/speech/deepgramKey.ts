/**
 * The Deepgram key is baked in at build time from the repo environment, the
 * same way the Clerk publishable key is, so a build handed to someone works
 * with no setup. Undefined leaves voice input disabled rather than failing at
 * the moment the mic is pressed.
 */
export function deepgramApiKey(): string | undefined {
  const value = process.env.EXPO_PUBLIC_DEEPGRAM_API_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}
