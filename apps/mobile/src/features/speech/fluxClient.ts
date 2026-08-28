export const FLUX_MODEL = "flux-general-multi";
const FLUX_URL = "wss://api.deepgram.com/v2/listen";
export const SAMPLE_RATE = 16_000;
const MAX_KEYTERMS = 100;
const CONNECT_TIMEOUT_MS = 10_000;
const FINALIZE_TIMEOUT_MS = 15_000;

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

export type FluxSessionOptions = {
  readonly apiKey: string;
  readonly keyterms?: ReadonlyArray<string>;
  readonly onPartial?: (text: string) => void;
};

/**
 * Streams microphone audio to Deepgram Flux from React Native.
 *
 * React Native's WebSocket cannot set request headers, so the key is passed
 * with Deepgram's token subprotocol -- the same mechanism browsers use.
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
    const socket = new WebSocket(buildFluxUrl(this.options.keyterms), [
      "token",
      this.options.apiKey,
    ]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("timed out connecting to Deepgram"));
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("could not reach Deepgram"));
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
