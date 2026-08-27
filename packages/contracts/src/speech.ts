import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const DesktopSpeechStateSchema = Schema.Literals([
  // No API key configured yet; the UI points at settings instead of the mic.
  "unconfigured",
  "ready",
  "recording",
  "transcribing",
  "error",
]);
export type DesktopSpeechState = typeof DesktopSpeechStateSchema.Type;

export const DesktopSpeechStatusSchema = Schema.Union([
  Schema.Struct({
    supported: Schema.Literal(false),
    reason: Schema.String,
  }),
  Schema.Struct({
    supported: Schema.Literal(true),
    state: DesktopSpeechStateSchema,
    message: Schema.optionalKey(Schema.String),
  }),
]);
export type DesktopSpeechStatus = typeof DesktopSpeechStatusSchema.Type;

export const DesktopSpeechEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    status: DesktopSpeechStatusSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("level"),
    level: Schema.Number,
    elapsedMs: NonNegativeInt,
  }),
  // Flux reports a running transcript for the current turn before it ends. This
  // is preview text only: it is replaced wholesale by the next partial and by
  // the final transcript, so it must never be inserted into the composer.
  Schema.Struct({
    type: Schema.Literal("partial"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
]);
export type DesktopSpeechEvent = typeof DesktopSpeechEventSchema.Type;
