import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { expectMemory, receiveMemories, useMemories } from "./memories.ts";

const item = (id: string, createdAt: number) => ({ id, summary: id, createdAt });

beforeEach(() => useMemories.setState({ items: [], awaiting: false, justSaved: null }));

test("the list is newest first", () => {
  receiveMemories([item("old", 1), item("new", 3), item("mid", 2)]);
  assert.deepEqual(useMemories.getState().items.map((m) => m.id), ["new", "mid", "old"]);
});

test("after Remember this, the memory that wasn't there before is the one just saved", () => {
  receiveMemories([item("seed", 1)]);
  expectMemory();
  receiveMemories([item("seed", 1), item("fresh", 2)]);
  assert.equal(useMemories.getState().justSaved?.id, "fresh");
});

test("the list sent on connect is not announced as just saved", () => {
  receiveMemories([item("seed", 1)]);
  assert.equal(useMemories.getState().justSaved, null);
});

test("a just-saved memory deleted by Undo is no longer offered for undo", () => {
  expectMemory();
  receiveMemories([item("fresh", 2)]);
  receiveMemories([]);
  assert.equal(useMemories.getState().justSaved, null);
});
