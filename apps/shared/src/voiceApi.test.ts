import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createConsent, pickRecordingType, recordingFileName, uploadVoice, VoiceApiError } from "./voiceApi.ts";

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("createConsent posts a voice_clone consent and returns its id", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const id = await createConsent(
    { sessionId: "demo", voiceOwner: "Alex", statement: "voice.consentCheck" },
    fakeFetch(201, { consentId: "c_1" }, calls),
  );
  assert.equal(id, "c_1");
  assert.equal(calls[0]!.url, "/api/consent");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    kind: "voice_clone",
    sessionId: "demo",
    voiceOwner: "Alex",
    statement: "voice.consentCheck",
  });
});

test("uploadVoice sends the sample, consent and session as multipart", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const sample = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const id = await uploadVoice(
    { sessionId: "demo", consentId: "c_1", sample, fileName: "sample.webm" },
    fakeFetch(201, { voiceId: "v_1" }, calls),
  );
  assert.equal(id, "v_1");
  const form = calls[0]!.init.body as FormData;
  assert.equal(calls[0]!.url, "/api/voices");
  assert.equal(form.get("consentId"), "c_1");
  assert.equal(form.get("sessionId"), "demo");
  assert.equal((form.get("audio") as File).name, "sample.webm");
});

test("gateway errors surface their code and message", async () => {
  await assert.rejects(
    uploadVoice(
      { sessionId: "demo", consentId: "nope", sample: new Blob(["x"]), fileName: "a.webm" },
      fakeFetch(403, { code: "no_consent", message: "Consent not found." }),
    ),
    (err: unknown) => err instanceof VoiceApiError && err.status === 403 && err.code === "no_consent",
  );
});

test("recording type and file name follow what the browser supports", () => {
  assert.equal(
    pickRecordingType((t) => t.startsWith("audio/mp4")),
    "audio/mp4",
  ); // iOS Safari
  assert.equal(
    pickRecordingType((t) => t.startsWith("audio/webm")),
    "audio/webm;codecs=opus",
  ); // Chrome
  assert.equal(
    pickRecordingType(() => false),
    undefined,
  );
  assert.equal(recordingFileName("audio/mp4;codecs=mp4a.40.2"), "sample.m4a");
  assert.equal(recordingFileName("audio/webm;codecs=opus"), "sample.webm");
});
