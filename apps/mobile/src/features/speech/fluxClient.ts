export const FLUX_MODEL = "flux-general-multi";
const FLUX_URL = "wss://api.deepgram.com/v2/listen";
export const SAMPLE_RATE = 16_000;
const MAX_KEYTERMS = 100;
const CONNECT_TIMEOUT_MS = 10_000;
// The EndOfTurn that answers CloseStream arrives in well under a second. This
// is only the backstop for a server that never answers, and it is a dead wait
// the user sits through, so it stays short.
const FINALIZE_TIMEOUT_MS = 5_000;

export function buildFluxUrl(keyterms: ReadonlyArray<string> = []): string {
  const params = new URLSearchParams();
  params.set("model", FLUX_MODEL);
  params.set("encoding", "linear16");
  params.set("sample_rate", String(SAMPLE_RATE));
  params.set("channels", "1");
  // The button release is the real end of the utterance, so stop Flux ending a
  // turn on a thinking pause. Both values are Deepgram's maximum.
  params.set("eot_threshold", "0.9");
  params.set("eot_timeout_ms", "60000");
  // Flux does not format numbers on its own; `numerals` is its own parameter
  // and defaults to false. Without it "july twenty twenty four" stays words.
  params.set("numerals", "true");
  for (const term of keyterms
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, MAX_KEYTERMS)) {
    params.append("keyterm", term);
  }
  return `${FLUX_URL}?${params.toString()}`;
}

/** Decodes base64 PCM from the native module into bytes the socket can send. */
export function decodeBase64(input: string): Uint8Array {
  const binary = globalThis.atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Deepgram refuses a bad key by closing the upgrade, so the close code and
 * reason are usually the only description of what went wrong.
 */
function connectFailureMessage(event: unknown): string {
  const detail = event as { message?: unknown; code?: unknown; reason?: unknown };
  const reason = typeof detail?.reason === "string" ? detail.reason.trim() : "";
  const message = typeof detail?.message === "string" ? detail.message.trim() : "";
  const code = typeof detail?.code === "number" ? detail.code : undefined;
  const described = reason || message;
  if (described && code !== undefined) return `could not reach Deepgram (${code}): ${described}`;
  if (described) return `could not reach Deepgram: ${described}`;
  if (code !== undefined) {
    // 1006 is an abnormal close with no frame, which is what a rejected key
    // looks like from the client side.
    return code === 1006
      ? "could not reach Deepgram: the connection was refused, which usually means the API key was rejected"
      : `could not reach Deepgram (${code})`;
  }
  return "could not reach Deepgram";
}

/**
 * React Native's WebSocket takes a third `options` argument carrying request
 * headers. The DOM lib types shipped with TypeScript describe the browser
 * constructor, which has no such parameter, so the runtime shape is declared
 * here rather than dropped.
 */
type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols: string | ReadonlyArray<string> | undefined,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

/** Resolved per connection rather than captured at import, so the constructor
 * in effect at connect time is the one used. */
function reactNativeWebSocket(): ReactNativeWebSocketConstructor {
  return globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor;
}

export type FluxSessionOptions = {
  readonly apiKey: string;
  readonly keyterms?: ReadonlyArray<string>;
  readonly onPartial?: (text: string) => void;
};

/**
 * Streams microphone audio to Deepgram Flux from React Native.
 *
 * Authentication uses the Authorization header, the same as the desktop
 * backend. React Native's WebSocket accepts a headers option and forwards it to
 * the platform client -- it is the *browser* that cannot set them, which is why
 * the token subprotocol exists at all. Offering `token` as a subprotocol Flux
 * never selects made the handshake fail outright ("could not reach Deepgram").
 */
export class FluxSession {
  private readonly options: FluxSessionOptions;
  private socket: WebSocket | undefined;
  private readonly turns = new Map<number, string>();
  private settleFinal: ((text: string) => void) | undefined;
  private rejectFinal: ((error: Error) => void) | undefined;
  private finalizeTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private failure: Error | undefined;

  constructor(options: FluxSessionOptions) {
    this.options = options;
  }

  async begin(): Promise<void> {
    if (this.socket) return;
    const Socket = reactNativeWebSocket();
    const socket = new Socket(buildFluxUrl(this.options.keyterms), undefined, {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("timed out connecting to Deepgram"));
      }, CONNECT_TIMEOUT_MS);
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        outcome();
      };
      socket.onopen = () => settle(resolve);
      // Whatever the platform reports is the only clue to a rejected key or a
      // blocked network, so it is carried through rather than flattened into a
      // single unhelpful sentence.
      socket.onerror = (event) => {
        settle(() => reject(new Error(connectFailureMessage(event))));
      };
      socket.onclose = (event) => {
        settle(() => reject(new Error(connectFailureMessage(event))));
      };
    });

    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => this.fail(new Error("the Deepgram connection failed"));
    socket.onclose = () => {
      if (this.settleFinal) this.fail(new Error("Deepgram closed the connection"));
    };
  }

  /** Non-blocking: a dropped frame must never stall microphone capture. */
  push(pcm: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.closing) return;
    socket.send(pcm);
  }

  async finish(): Promise<string> {
    const socket = this.socket;
    if (!socket) throw new Error("the Deepgram stream is not open");
    if (this.failure) throw this.failure;
    this.closing = true;

    const transcript = await new Promise<string>((resolve, reject) => {
      this.settleFinal = resolve;
      this.rejectFinal = reject;
      this.finalizeTimer = setTimeout(() => this.settle(this.collect()), FINALIZE_TIMEOUT_MS);
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "CloseStream" }));
      else this.settle(this.collect());
    });

    this.dispose();
    return transcript;
  }

  dispose(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = undefined;
    this.settleFinal = undefined;
    this.rejectFinal = undefined;
    this.turns.clear();
    socket?.close();
  }

  /** Exposed for tests: feed one raw frame exactly as the socket would. */
  handleFrame(json: string): void {
    this.receive(json);
  }

  /** Exposed for tests: the transcript assembled so far. */
  get transcript(): string {
    return this.collect();
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const message = event as {
      type?: unknown;
      event?: unknown;
      turn_index?: unknown;
      transcript?: unknown;
      description?: unknown;
    };

    if (message.type === "Error") {
      const description =
        typeof message.description === "string" ? message.description : "unknown error";
      this.fail(new Error(`Deepgram error: ${description}`));
      return;
    }

    // Flux only ever sends `type: "TurnInfo"`. The lifecycle lives in `event`
    // (StartOfTurn | Update | EagerEndOfTurn | TurnResumed | EndOfTurn) -- there
    // is no message whose type is "EndOfTurn".
    if (message.type !== "TurnInfo") return;

    const index = typeof message.turn_index === "number" ? message.turn_index : 0;
    const text = typeof message.transcript === "string" ? message.transcript.trim() : "";
    // A bare StartOfTurn, or silence closing a turn, arrives with no text and
    // must never erase what the turn already holds.
    if (text.length > 0) this.turns.set(index, text);

    if (message.event === "EndOfTurn") {
      // The EndOfTurn that follows CloseStream is the one that completes the
      // transcript; earlier ones just close a turn mid-dictation.
      if (this.closing) this.settle(this.collect());
      return;
    }
    this.options.onPartial?.(this.collect());
  }

  private collect(): string {
    return [...this.turns.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text.trim())
      .filter((text) => text.length > 0)
      .join(" ")
      .trim();
  }

  private settle(text: string): void {
    const resolve = this.settleFinal;
    if (!resolve) return;
    this.settleFinal = undefined;
    this.rejectFinal = undefined;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = undefined;
    resolve(text);
  }

  private fail(error: Error): void {
    this.failure = error;
    const reject = this.rejectFinal;
    if (!reject) return;
    this.settleFinal = undefined;
    this.rejectFinal = undefined;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = undefined;
    reject(error);
  }
}
