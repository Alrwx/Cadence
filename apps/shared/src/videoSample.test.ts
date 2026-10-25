import { strict as assert } from "node:assert";
import { test } from "node:test";
import { encodeWav, trimToMono } from "./videoSample.ts";

test("trimToMono averages the channels and keeps only the first maxSeconds", () => {
  const left = new Float32Array([1, 1, 1, 1, 1, 1]);
  const right = new Float32Array([0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...trimToMono([left, right], 2, 2)], [0.5, 0.5, 0.5, 0.5]);
});

test("trimToMono keeps a clip shorter than the limit whole", () => {
  assert.deepEqual([...trimToMono([new Float32Array([0.25, -0.25])], 10, 30)], [0.25, -0.25]);
  assert.equal(trimToMono([], 10, 30).length, 0);
});

test("encodeWav writes a 16-bit mono PCM header and clamped samples", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 24000);
  const view = new DataView(wav.buffer);
  const text = (offset: number, n: number) => String.fromCharCode(...wav.subarray(offset, offset + n));
  assert.equal(wav.length, 44 + 8);
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true)),
    [0, 32767, -32767, 32767],
  );
});
