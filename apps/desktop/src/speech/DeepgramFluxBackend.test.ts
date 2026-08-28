import { describe, expect, it } from "vite-plus/test";

import { DeepgramFluxBackend, FLUX_MODEL, buildFluxUrl } from "./DeepgramFluxBackend.ts";

describe("buildFluxUrl", () => {
  it("targets the Flux endpoint with the multilingual model", () => {
    const url = new URL(buildFluxUrl("key"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v2/listen");
    // -en would silently force English on a multilingual user.
    expect(url.searchParams.get("model")).toBe("flux-general-multi");
    expect(FLUX_MODEL).toBe("flux-general-multi");
  });

  it("asks for numerals, which Flux does not format on its own", () => {
    // smart_format is a /v1 parameter; Flux rejects it and splits number
    // formatting into `numerals`, which defaults to false.
    const url = buildFluxUrl("key");
    expect(new URL(url).searchParams.get("numerals")).toBe("true");
    expect(url).not.toContain("smart_format");
  });

  it("tells Flux not to end a turn on a thinking pause", () => {
    const params = new URL(buildFluxUrl("key")).searchParams;
    expect(params.get("eot_threshold")).toBe("0.9");
    expect(params.get("eot_timeout_ms")).toBe("60000");
  });

  it("describes the audio it will actually send", () => {
    const params = new URL(buildFluxUrl("key")).searchParams;
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe("16000");
    expect(params.get("channels")).toBe("1");
  });

  it("forwards keyterms and drops blank ones", () => {
    const params = new URL(buildFluxUrl("key", ["Handy", "   ", "Deepgram"])).searchParams;
    expect(params.getAll("keyterm")).toEqual(["Handy", "Deepgram"]);
  });

  it("keeps a multi-word keyterm as a single phrase", () => {
    const params = new URL(buildFluxUrl("key", ["Krea 2"])).searchParams;
    expect(params.getAll("keyterm")).toEqual(["Krea 2"]);
  });

  it("caps keyterms rather than letting Deepgram reject the request", () => {
    const many = Array.from({ length: 150 }, (_, index) => `term${index}`);
    expect(new URL(buildFluxUrl("key", many)).searchParams.getAll("keyterm")).toHaveLength(100);
  });

  it("never puts the api key in the url", () => {
    expect(buildFluxUrl("super-secret-key")).not.toContain("super-secret-key");
  });
});

describe("Flux frame handling", () => {
  const session = () => new DeepgramFluxBackend({ apiKey: "k" });

  it("accumulates a turn from TurnInfo frames", () => {
    const s = session();
    s.handleFrame(JSON.stringify({ type: "TurnInfo", event: "StartOfTurn", turn_index: 0 }));
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "Update", turn_index: 0, transcript: "hello" }),
    );
    s.handleFrame(
      JSON.stringify({
        type: "TurnInfo",
        event: "Update",
        turn_index: 0,
        transcript: "hello there",
      }),
    );
    expect(s.transcript).toBe("hello there");
  });

  it("never treats EndOfTurn as a message type", () => {
    // Flux has no frame whose `type` is "EndOfTurn"; matching on type instead
    // of event means the final turn never settles and dictation falls back to
    // the failsafe timeout.
    const s = session();
    s.handleFrame(JSON.stringify({ type: "EndOfTurn", transcript: "ignored" }));
    expect(s.transcript).toBe("");
  });

  it("keys turns by the server's turn_index, not arrival order", () => {
    const s = session();
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", turn_index: 1, transcript: "second" }),
    );
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "first" }),
    );
    expect(s.transcript).toBe("first second");
  });

  it("does not let an empty frame erase text the turn already holds", () => {
    const s = session();
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "Update", turn_index: 0, transcript: "kept" }),
    );
    s.handleFrame(JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", turn_index: 0 }));
    expect(s.transcript).toBe("kept");
  });

  it("reports partials only while a turn is open", () => {
    const seen: string[] = [];
    const s = new DeepgramFluxBackend({ apiKey: "k", onPartial: (t) => seen.push(t) });
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "Update", turn_index: 0, transcript: "partial" }),
    );
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "final" }),
    );
    expect(seen).toEqual(["partial"]);
  });
});
