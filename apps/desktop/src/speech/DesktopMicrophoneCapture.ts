// @effect-diagnostics globalDate:off - native microphone callback is outside Effect runtime.
import { PvRecorder } from "@picovoice/pvrecorder-node";

const SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 512;

export class DesktopMicrophoneCapture {
  private readonly onLevel: (level: number, elapsedMs: number) => void;
  private readonly onFrame: (frame: Int16Array) => void;
  private recorder: PvRecorder | undefined;
  private readLoop: Promise<void> | undefined;
  private stopping = false;
  private readError: Error | undefined;
  private startedAt = 0;
  private lastLevelAt = 0;
  private sawAudio = false;

  constructor(
    onLevel: (level: number, elapsedMs: number) => void,
    onFrame: (frame: Int16Array) => void,
  ) {
    this.onLevel = onLevel;
    this.onFrame = onFrame;
  }

  start(): void {
    if (this.recorder) throw new Error("microphone capture is already active");
    const recorder = new PvRecorder(FRAME_LENGTH, -1);
    try {
      if (recorder.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `microphone reported ${recorder.sampleRate} Hz; expected ${SAMPLE_RATE} Hz`,
        );
      }
      this.stopping = false;
      this.readError = undefined;
      this.sawAudio = false;
      this.startedAt = Date.now();
      this.lastLevelAt = 0;
      recorder.start();
      this.recorder = recorder;
      this.readLoop = this.readFrames(recorder);
    } catch (error) {
      recorder.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("microphone capture is not active");
    this.stopping = true;
    try {
      if (recorder.isRecording) recorder.stop();
      await this.readLoop;
    } finally {
      recorder.release();
      this.recorder = undefined;
      this.readLoop = undefined;
    }
    if (this.readError) throw this.readError;
    if (!this.sawAudio) throw new Error("no microphone audio was captured");
  }

  async cancel(): Promise<void> {
    if (!this.recorder) return;
    await this.stop().catch(() => undefined);
  }

  private async readFrames(recorder: PvRecorder): Promise<void> {
    try {
      while (!this.stopping && recorder.isRecording) {
        const frame = await recorder.read();
        if (this.stopping) continue;
        this.sawAudio = true;
        // Frames go straight to the transcription socket; nothing is buffered,
        // so a long dictation costs no memory and the server sees audio while
        // the user is still speaking.
        this.onFrame(frame);
        const now = Date.now();
        if (now - this.lastLevelAt >= 100) {
          this.lastLevelAt = now;
          let energy = 0;
          for (const sample of frame) energy += (sample / 32_768) ** 2;
          this.onLevel(
            Math.min(1, Math.sqrt(energy / Math.max(1, frame.length)) * 8),
            now - this.startedAt,
          );
        }
      }
    } catch (error) {
      if (!this.stopping)
        this.readError = error instanceof Error ? error : new Error(String(error));
    }
  }
}
