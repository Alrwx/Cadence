import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { receiveConversations, toggleAttached, useConversations } from "./conversations.ts";

const item = (id: string, startedAt: number) => ({ id, label: id, startedAt });

beforeEach(() => useConversations.setState({ items: [], attached: [] }));

test("toggling returns the whole attached set, so detaching the last one sends an empty list", () => {
  receiveConversations([item("cv_1", 1), item("cv_2", 2)]);
  assert.deepEqual(toggleAttached("cv_1"), ["cv_1"]);
  assert.deepEqual(toggleAttached("cv_2"), ["cv_1", "cv_2"]);
  assert.deepEqual(toggleAttached("cv_1"), ["cv_2"]);
  assert.deepEqual(toggleAttached("cv_2"), []);
});

test("a conversation deleted elsewhere is no longer attached", () => {
  receiveConversations([item("cv_1", 1), item("cv_2", 2)]);
  toggleAttached("cv_1");
  toggleAttached("cv_2");
  receiveConversations([item("cv_2", 2)]);
  assert.deepEqual(useConversations.getState().attached, ["cv_2"]);
});

test("the list is newest first", () => {
  receiveConversations([item("old", 1), item("new", 3), item("mid", 2)]);
  assert.deepEqual(useConversations.getState().items.map((c) => c.id), ["new", "mid", "old"]);
});
