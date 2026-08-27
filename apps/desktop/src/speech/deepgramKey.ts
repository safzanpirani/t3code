/**
 * Voice input needs a Deepgram key. It is read from the environment so a build
 * can carry one (set in the repo `.env` at build time, the same way the Clerk
 * publishable key is) and so a user can override it per-machine without a
 * rebuild. Returns undefined when unset, which leaves voice input disabled
 * rather than failing at the moment someone presses the mic.
 */
export function deepgramApiKey(): string | undefined {
  for (const name of ["T3CODE_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
