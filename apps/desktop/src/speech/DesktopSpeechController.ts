// @effect-diagnostics globalTimers:off - this timer bounds native microphone capture.
import type { DesktopSpeechEvent, DesktopSpeechStatus } from "@t3tools/contracts";

type Capture = {
  start(): void;
  stop(): Promise<void>;
  cancel(): Promise<void>;
};

type Backend = {
  begin(): Promise<void>;
  push(frame: Int16Array): void;
  finish(): Promise<string>;
  dispose(): Promise<void>;
};

type ControllerOptions = {
  supported: boolean;
  unsupportedReason?: string;
  /** False until an API key is configured; the mic stays disabled until then. */
  configured(): boolean;
  createCapture(onFrame: (frame: Int16Array) => void): Capture;
  createBackend(): Backend;
  emit(event: DesktopSpeechEvent): void;
  maxRecordingMs?: number;
};

export class DesktopSpeechController {
  private readonly options: ControllerOptions;
  private capture: Capture | undefined;
  private backend: Backend | undefined;
  private state: "unconfigured" | "ready" | "recording" | "transcribing" | "error" = "ready";
  private operation: Promise<DesktopSpeechStatus> | undefined;
  private recordingTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelRequested = false;

  constructor(options: ControllerOptions) {
    this.options = options;
  }

  async getStatus(): Promise<DesktopSpeechStatus> {
    if (!this.options.supported) {
      return { supported: false, reason: this.options.unsupportedReason ?? "unsupported platform" };
    }
    if (this.state === "unconfigured" && this.options.configured()) this.state = "ready";
    if (this.state === "ready" && !this.options.configured()) this.state = "unconfigured";
    return { supported: true, state: this.state };
  }

  start(): Promise<DesktopSpeechStatus> {
    return this.exclusive(async () => {
      const initial = await this.getStatus();
      if (!initial.supported) return initial;
      if (this.capture) return { supported: true, state: this.state };
      if (!this.options.configured()) {
        this.setState("unconfigured");
        return { supported: true, state: "unconfigured" };
      }

      const backend = this.options.createBackend();
      // The socket opens before the first frame so connection setup is not on
      // the critical path between speaking and seeing text.
      await backend.begin();
      if (this.cancelRequested) {
        await backend.dispose().catch(() => undefined);
        this.setState("ready");
        return { supported: true, state: "ready" };
      }

      const capture = this.options.createCapture((frame) => backend.push(frame));
      this.capture = capture;
      this.backend = backend;
      try {
        capture.start();
      } catch (error) {
        this.capture = undefined;
        this.backend = undefined;
        await backend.dispose().catch(() => undefined);
        throw error;
      }
      this.setState("recording");
      this.recordingTimer = setTimeout(
        () => void this.stop(),
        this.options.maxRecordingMs ?? 120_000,
      );
      this.recordingTimer.unref?.();
      return { supported: true, state: "recording" };
    });
  }

  stop(): Promise<DesktopSpeechStatus> {
    return this.exclusive(async () => {
      const capture = this.capture;
      const backend = this.backend;
      if (!capture || !backend) return this.getStatus();
      this.capture = undefined;
      this.clearRecordingTimer();
      this.setState("transcribing");
      try {
        await capture.stop();
        if (this.cancelRequested) {
          this.setState("ready");
          return { supported: true, state: "ready" };
        }
        const text = (await backend.finish()).trim();
        if (!this.cancelRequested && text) this.options.emit({ type: "transcript", text });
        this.setState("ready");
        return { supported: true, state: "ready" };
      } finally {
        this.backend = undefined;
        await backend.dispose().catch(() => undefined);
      }
    });
  }

  cancel(): Promise<DesktopSpeechStatus> {
    this.cancelRequested = true;
    return this.exclusive(async () => {
      const capture = this.capture;
      const backend = this.backend;
      this.capture = undefined;
      this.clearRecordingTimer();
      this.backend = undefined;
      await capture?.cancel().catch(() => undefined);
      await backend?.dispose().catch(() => undefined);
      this.setState(this.options.configured() ? "ready" : "unconfigured");
      this.cancelRequested = false;
      return { supported: true, state: this.state };
    });
  }

  async shutdown(): Promise<void> {
    await this.cancel().catch(() => undefined);
  }

  private setState(state: typeof this.state): void {
    this.state = state;
    this.options.emit({ type: "status", status: { supported: true, state } });
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
  }

  private exclusive(task: () => Promise<DesktopSpeechStatus>): Promise<DesktopSpeechStatus> {
    const previous = this.operation;
    const operation = (previous ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.state = "error";
        this.options.emit({ type: "error", message });
        this.options.emit({
          type: "status",
          status: { supported: true, state: "error", message },
        });
        return { supported: true, state: "error", message } as const;
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
      });
    this.operation = operation;
    return operation;
  }
}
