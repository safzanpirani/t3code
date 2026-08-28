/**
 * Pure key handling, kept apart from the SecureStore module so the rules can be
 * tested without pulling React Native into the test process.
 */

/**
 * Deepgram keys are opaque, but a pasted key routinely arrives with a trailing
 * newline or surrounding quotes from a password manager, and those reach the
 * WebSocket subprotocol verbatim and fail authentication with no useful error.
 */
export function normalizeDeepgramKey(value: string): string | undefined {
  const unquoted = value.trim().replace(/^["']|["']$/g, "");
  const trimmed = unquoted.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Enough to confirm which key is stored without showing it in full. */
export function maskDeepgramKey(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(6)}${value.slice(-4)}`;
}
