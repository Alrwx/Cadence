# Saved-phrase management on the phone: three gateway/protocol gaps

**For:** Dev 4 (gateway + protocol) · **From:** Dev 2 · **Date:** 2026-10-24

AGENTS(GH).md §7 now gives the phone saved-phrase management (add, edit, delete, reorder phrases and groups) over the `phrase.*` events, and §6.1 lists `phrases` as gw → headset, phone. The phone screen is built (`apps/phone/src/PhraseManager.tsx`) and works against the mock gateway. Three things are missing on the real side.

## 1. Send `phrases` to the phone (gateway, small)

`sendPhrases` in `services/gateway/internal/orchestrator/phrases.go` sends only to `hub.Headset`, and `OnConnect` only sends it when the headset connects. The phone never gets the list, so its screen stays on "Loading saved phrases…".

Proposed: send `phrases` to both roles on connect and after every change (the mock already does this, `sendPhrases(s, "all")`).

Related: `sendError` always targets the headset, so a rejected phone edit (for example `not_found` after the headset deleted the group) is never shown on the phone. The mock sends errors back to the client that sent the event; the gateway could do the same by passing `from` through `onPhraseEvent`.

## 2. Edit a phrase in place (protocol, additive)

`phrase.save` is `{ text, groupId, fromClipId? }`, so it can only create. The phone edits a phrase today by sending `phrase.save` with the new text, then `phrase.delete` for the old one. That works, but the edited phrase moves to the end of its group and gets a new id.

Proposed: an optional `phraseId` on `phrase.save`. With it, the gateway updates that phrase's text (and re-synthesizes its clip); without it, it creates a phrase as today. Additive, so no `v` bump.

## 3. Reorder phrases within a group (protocol, additive)

Groups can be reordered (`phrase.group.save` has `order`), phrases can't. Proposed: an optional `order` on `phrase.save`, used together with `phraseId` (move phrase `phraseId` to position `order` in its group), mirroring `phrase.group.save`.

## Phone side once these land

- (1) needs no phone change.
- (2) and (3): the phone switches its edit to one `phrase.save` with `phraseId`, and adds ↑/↓ buttons on phrases like the group ones. The mock gateway (Dev 2) gets the same behavior first.
