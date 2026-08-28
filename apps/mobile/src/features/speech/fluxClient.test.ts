import { describe, expect, it } from "vite-plus/test";

import { FLUX_MODEL, FluxSession, SAMPLE_RATE, buildFluxUrl, decodeBase64 } from "./fluxClient";

describe("buildFluxUrl", () => {
  it("targets Flux with the multilingual model", () => {
    const url = new URL(buildFluxUrl());
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v2/listen");
    // -en would silently force English on a multilingual user.
    expect(url.searchParams.get("model")).toBe("flux-general-multi");
    expect(FLUX_MODEL).toBe("flux-general-multi");
  });

  it("asks for numerals, which Flux does not format on its own", () => {
    const url = buildFluxUrl();
    expect(new URL(url).searchParams.get("numerals")).toBe("true");
    // smart_format is /v1 only; Flux rejects it.
    expect(url).not.toContain("smart_format");
  });

  it("tells Flux not to end a turn on a thinking pause", () => {
    const params = new URL(buildFluxUrl()).searchParams;
    expect(params.get("eot_threshold")).toBe("0.9");
    expect(params.get("eot_timeout_ms")).toBe("60000");
  });

  it("describes the audio the native module actually produces", () => {
    const params = new URL(buildFluxUrl()).searchParams;
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe(String(SAMPLE_RATE));
    expect(SAMPLE_RATE).toBe(16_000);
    expect(params.get("channels")).toBe("1");
  });

  it("forwards keyterms, drops blanks, and keeps phrases whole", () => {
    const params = new URL(buildFluxUrl(["Krea 2", "   ", "Deepgram"])).searchParams;
    expect(params.getAll("keyterm")).toEqual(["Krea 2", "Deepgram"]);
  });

  it("never puts the api key in the url", () => {
    // The key travels in the Authorization header; it must not leak into the
    // query string, which lands in server logs.
    expect(buildFluxUrl()).not.toContain("token");
  });
});

describe("connecting", () => {
  class FakeSocket {
    static last: FakeSocket | undefined;
    readonly url: string;
    readonly protocols: unknown;
    readonly options: { readonly headers: Readonly<Record<string, string>> };
    binaryType = "";
    onopen: (() => void) | undefined;
    onerror: ((event: unknown) => void) | undefined;
    onclose: ((event: unknown) => void) | undefined;
    onmessage: ((event: unknown) => void) | undefined;
    closed = false;

    constructor(
      url: string,
      protocols: unknown,
      options: { readonly headers: Readonly<Record<string, string>> },
    ) {
      this.url = url;
      this.protocols = protocols;
      this.options = options;
      FakeSocket.last = this;
    }

    close() {
      this.closed = true;
    }
  }

  const withFakeSocket = async (run: (session: FluxSession) => Promise<void>) => {
    const original = globalThis.WebSocket;
    // @ts-expect-error -- the fake stands in for the platform constructor.
    globalThis.WebSocket = FakeSocket;
    try {
      await run(new FluxSession({ apiKey: "secret-key" }));
    } finally {
      globalThis.WebSocket = original;
    }
  };

  it("authenticates with the Authorization header, not a subprotocol", async () => {
    await withFakeSocket(async (session) => {
      const begun = session.begin();
      // Offering a subprotocol Flux never selects failed the handshake.
      expect(FakeSocket.last?.protocols).toBeUndefined();
      expect(FakeSocket.last?.options.headers.Authorization).toBe("Token secret-key");
      FakeSocket.last?.onopen?.();
      await begun;
    });
  });

  it("reports the close code when the handshake is refused", async () => {
    await withFakeSocket(async (session) => {
      const begun = session.begin();
      FakeSocket.last?.onclose?.({ code: 1006 });
      await expect(begun).rejects.toThrow(/API key was rejected/);
    });
  });

  it("carries the platform's own description through", async () => {
    await withFakeSocket(async (session) => {
      const begun = session.begin();
      FakeSocket.last?.onerror?.({ message: "dns failure" });
      await expect(begun).rejects.toThrow(/dns failure/);
    });
  });
});

describe("decodeBase64", () => {
  it("round-trips the little-endian PCM the native module sends", () => {
    // 0x0100 and 0xFF7F little-endian => samples 1 and 32767.
    const bytes = decodeBase64(globalThis.btoa("\x01\x00\xff\x7f"));
    expect([...bytes]).toEqual([0x01, 0x00, 0xff, 0x7f]);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    expect([...samples]).toEqual([1, 32_767]);
  });

  it("returns an empty buffer for empty input", () => {
    expect(decodeBase64("").length).toBe(0);
  });
});

describe("Flux frame handling", () => {
  const session = () => new FluxSession({ apiKey: "k" });

  it("accumulates a turn from TurnInfo frames", () => {
    const s = session();
    s.handleFrame(JSON.stringify({ type: "TurnInfo", event: "StartOfTurn", turn_index: 0 }));
    s.handleFrame(
      JSON.stringify({ type: "TurnInfo", event: "Update", turn_index: 0, transcript: "hello" }),
    );
    expect(s.transcript).toBe("hello");
  });

  it("never treats EndOfTurn as a message type", () => {
    // Flux has no frame whose `type` is "EndOfTurn"; matching on type instead
    // of event means the final turn never settles.
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
});
