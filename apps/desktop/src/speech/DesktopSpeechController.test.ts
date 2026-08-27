import type { DesktopSpeechEvent } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopSpeechController } from "./DesktopSpeechController.ts";

function makeController(
  options: { configured?: boolean; maxRecordingMs?: number; transcript?: string } = {},
) {
  const events: DesktopSpeechEvent[] = [];
  let onFrame: ((frame: Int16Array) => void) | undefined;
  const capture = {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const backend = {
    begin: vi.fn().mockResolvedValue(undefined),
    push: vi.fn(),
    finish: vi.fn().mockResolvedValue(options.transcript ?? "hello there"),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new DesktopSpeechController({
    supported: true,
    configured: () => options.configured ?? true,
    createCapture: (frameSink) => {
      onFrame = frameSink;
      return capture;
    },
    createBackend: () => backend,
    emit: (event) => events.push(event),
    ...(options.maxRecordingMs === undefined ? {} : { maxRecordingMs: options.maxRecordingMs }),
  });
  return { controller, capture, backend, events, frame: (f: Int16Array) => onFrame?.(f) };
}

describe("DesktopSpeechController", () => {
  it("records, streams, and emits the final transcript", async () => {
    const { controller, capture, backend, events } = makeController();

    expect(await controller.start()).toMatchObject({ supported: true, state: "recording" });
    expect(await controller.stop()).toMatchObject({ supported: true, state: "ready" });

    expect(capture.start).toHaveBeenCalledOnce();
    expect(backend.begin).toHaveBeenCalledOnce();
    expect(backend.finish).toHaveBeenCalledOnce();
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "transcript", text: "hello there" });
  });

  it("opens the socket before capture starts so setup is off the critical path", async () => {
    const order: string[] = [];
    const { controller, capture, backend } = makeController();
    backend.begin.mockImplementation(async () => void order.push("begin"));
    capture.start.mockImplementation(() => void order.push("capture"));

    await controller.start();

    expect(order).toEqual(["begin", "capture"]);
  });

  it("streams captured frames straight to the backend", async () => {
    const { controller, backend, frame } = makeController();
    await controller.start();

    frame(Int16Array.from([1, 2, 3]));
    frame(Int16Array.from([4, 5, 6]));

    expect(backend.push).toHaveBeenCalledTimes(2);
    expect(backend.push).toHaveBeenLastCalledWith(Int16Array.from([4, 5, 6]));
  });

  it("stays unconfigured and never opens a socket without an API key", async () => {
    const { controller, backend, capture } = makeController({ configured: false });

    expect(await controller.start()).toMatchObject({ supported: true, state: "unconfigured" });
    expect(backend.begin).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("discards the transcript when cancelled", async () => {
    const { controller, capture, events } = makeController();
    await controller.start();

    expect(await controller.cancel()).toMatchObject({ supported: true, state: "ready" });

    expect(capture.cancel).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "transcript")).toBe(false);
  });

  it("suppresses an empty transcript rather than inserting nothing", async () => {
    const { controller, events } = makeController({ transcript: "   " });
    await controller.start();
    await controller.stop();

    expect(events.some((event) => event.type === "transcript")).toBe(false);
  });

  it("reports a backend failure as an error state", async () => {
    const { controller, backend, events } = makeController();
    backend.finish.mockRejectedValue(new Error("Deepgram closed the connection"));
    await controller.start();

    expect(await controller.stop()).toMatchObject({ supported: true, state: "error" });
    expect(events).toContainEqual({
      type: "error",
      message: "Deepgram closed the connection",
    });
  });
});
