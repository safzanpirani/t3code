// @effect-diagnostics globalTimers:off - the socket needs its own connect/finalize deadlines.
import { WebSocket } from "ws";

export const FLUX_MODEL = "flux-general-multi";
const FLUX_URL = "wss://api.deepgram.com/v2/listen";
const SAMPLE_RATE = 16_000;
/** Deepgram caps keyterm prompting; stay well under it rather than 400ing. */
const MAX_KEYTERMS = 100;
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * The flush EndOfTurn is what makes a transcript complete, so we wait for it
 * rather than a quiet timer -- but never forever, or a dropped socket would
 * hang the composer.
 */
const FINALIZE_TIMEOUT_MS = 15_000;

export type FluxBackendOptions = {
  readonly apiKey: string;
  readonly keyterms?: ReadonlyArray<string>;
  readonly onPartial?: (text: string) => void;
};

export function buildFluxUrl(apiKey: string, keyterms: ReadonlyArray<string> = []): string {
  const url = new URL(FLUX_URL);
  const q = url.searchParams;
  q.set("model", FLUX_MODEL);
  q.set("encoding", "linear16");
  q.set("sample_rate", String(SAMPLE_RATE));
  q.set("channels", "1");
  // The key release is the real end of the utterance, so stop Flux ending a
  // turn on a thinking pause. Both values are Deepgram's maximum.
  q.set("eot_threshold", "0.9");
  q.set("eot_timeout_ms", "60000");
  // Flux does NOT format numbers on its own -- `numerals` is its own parameter
  // and defaults to false. Without it "july twenty twenty four" stays words.
  q.set("numerals", "true");
  for (const term of keyterms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_KEYTERMS)) {
    q.append("keyterm", term);
  }
  void apiKey;
  return url.toString();
}

type Turn = { readonly index: number; readonly text: string };

/**
 * Streams microphone audio to Deepgram Flux and resolves the transcript once
 * the server confirms the final turn.
 *
 * Flux is turn-based: it reports a running transcript for the current turn and
 * closes it with an EndOfTurn. Turns are accumulated by index so a long
 * dictation split across several turns still yields the whole utterance.
 */
export class DeepgramFluxBackend {
  private readonly options: FluxBackendOptions;
  private socket: WebSocket | undefined;
  private readonly turns = new Map<number, string>();
  private currentIndex = 0;
  private finalize: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  private finalizeTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private failure: Error | undefined;

  constructor(options: FluxBackendOptions) {
    this.options = options;
  }

  async begin(): Promise<void> {
    if (this.socket) return;
    const socket = new WebSocket(buildFluxUrl(this.options.apiKey, this.options.keyterms), {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("timed out connecting to Deepgram"));
      }, CONNECT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    socket.on("message", (data: Buffer) => this.receive(data));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => {
      // A close before the flush EndOfTurn means the transcript never
      // completed; surface that rather than returning a truncated one.
      if (this.finalize) this.fail(new Error("Deepgram closed the connection"));
    });
  }

  /** Non-blocking: dropped frames must never stall microphone capture. */
  push(frame: Int16Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.closing) return;
    socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }

  async finish(): Promise<string> {
    const socket = this.socket;
    if (!socket) throw new Error("the Deepgram stream is not open");
    if (this.failure) throw this.failure;
    this.closing = true;

    const transcript = await new Promise<string>((resolve, reject) => {
      this.finalize = { resolve, reject };
      this.finalizeTimer = setTimeout(() => {
        // Fall back to whatever turns already closed rather than losing the
        // dictation outright.
        this.settle(this.collect());
      }, FINALIZE_TIMEOUT_MS);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CloseStream" }));
      } else {
        this.settle(this.collect());
      }
    });

    await this.dispose();
    return transcript;
  }

  async dispose(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = undefined;
    this.finalize = undefined;
    this.turns.clear();
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  private receive(data: Buffer): void {
    let event: unknown;
    try {
      event = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const message = event as { type?: unknown; transcript?: unknown; description?: unknown };

    if (message.type === "Error") {
      const description =
        typeof message.description === "string" ? message.description : "unknown error";
      this.fail(new Error(`Deepgram error: ${description}`));
      return;
    }

    const text = typeof message.transcript === "string" ? message.transcript : undefined;

    if (message.type === "TurnInfo" && text !== undefined) {
      this.turns.set(this.currentIndex, text);
      this.options.onPartial?.(this.collect());
      return;
    }

    if (message.type === "EndOfTurn") {
      if (text !== undefined) this.turns.set(this.currentIndex, text);
      this.currentIndex += 1;
      // The EndOfTurn that follows CloseStream is the one that completes the
      // transcript. Earlier ones just close a turn mid-dictation.
      if (this.closing) this.settle(this.collect());
    }
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
    const pending = this.finalize;
    if (!pending) return;
    this.finalize = undefined;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = undefined;
    pending.resolve(text);
  }

  private fail(error: Error): void {
    this.failure = error;
    const pending = this.finalize;
    if (!pending) return;
    this.finalize = undefined;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = undefined;
    pending.reject(error);
  }
}
