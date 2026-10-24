// Contract test: every example parses and matches its schema; every event has an example.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { EVENT_TYPES, isEventType, type CadenceEvent } from "../ts/index.ts";

const root = join(import.meta.dirname, "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv2020({ strict: false });
const envelope = ajv.compile(readJson(join(root, "schema", "envelope.schema.json")) as object);

test("every event type has an example", () => {
  const examples = readdirSync(join(root, "examples")).map((f) => f.replace(/\.json$/, ""));
  assert.deepEqual([...examples].sort(), [...EVENT_TYPES].sort());
});

for (const file of readdirSync(join(root, "examples"))) {
  test(`example ${file} matches its schema`, () => {
    const event = readJson(join(root, "examples", file)) as CadenceEvent;
    assert.ok(envelope(event), ajv.errorsText(envelope.errors));
    assert.ok(isEventType(event.type), `unknown type ${event.type}`);
    const data = ajv.compile(readJson(join(root, "schema", `${event.type}.schema.json`)) as object);
    assert.ok(data(event.data), ajv.errorsText(data.errors));
  });
}
