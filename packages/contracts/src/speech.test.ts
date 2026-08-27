import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DesktopSpeechEventSchema, DesktopSpeechStatusSchema } from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(DesktopSpeechStatusSchema);
const decodeEvent = Schema.decodeUnknownSync(DesktopSpeechEventSchema);

describe("desktop speech contracts", () => {
  it("accepts a ready status", () => {
    expect(decodeStatus({ supported: true, state: "ready" })).toEqual({
      supported: true,
      state: "ready",
    });
  });

  it("accepts the unconfigured state used before an API key is set", () => {
    expect(decodeStatus({ supported: true, state: "unconfigured" })).toEqual({
      supported: true,
      state: "unconfigured",
    });
  });

  it("rejects states left behind by the local-model implementation", () => {
    expect(() => decodeStatus({ supported: true, state: "missing-model" })).toThrow();
    expect(() => decodeStatus({ supported: true, state: "downloading" })).toThrow();
  });

  it("carries partial and final transcripts as distinct events", () => {
    expect(decodeEvent({ type: "partial", text: "hello" })).toEqual({
      type: "partial",
      text: "hello",
    });
    expect(decodeEvent({ type: "transcript", text: "hello there" })).toEqual({
      type: "transcript",
      text: "hello there",
    });
  });

  it("rejects a negative elapsed time on a level event", () => {
    expect(() => decodeEvent({ type: "level", level: 0.5, elapsedMs: -1 })).toThrow();
  });
});
