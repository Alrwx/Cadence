# Ignore events from a replaced socket in `GatewayConnection`

**For:** Dev 2 (owner of `apps/shared`) · **From:** Dev 1 · **Date:** 2026-10-24

## Problem
`GatewayConnection.connect()` installs `onopen` / `onclose` handlers that act on `this`, not on the socket they belong to. If `connect()` runs again while an older socket is still closing, the older socket's `onclose` fires later and:

1. sets `this.ws = null`, dropping the live socket, so `send()` returns `false` until a reconnect lands;
2. sees `closedByUser === false` (the new `connect()` reset it) and schedules another reconnect, so the gateway sees a third connection.

It shows up in dev under React StrictMode, which runs effects as connect → close → connect. The headset lost its `phone.unlock` this way in the end-to-end tests. The mock gateway log showed three `connected headset` lines per page load and only one `hello`. It can also happen in production whenever `close()` is followed quickly by `connect()`.

The headset now connects once from `main.tsx`, outside React, so it no longer hits this. The phone app still connects inside a `useEffect`.

## Proposed fix (`apps/shared/src/connection.ts`)
Make each handler a no-op once its socket has been replaced:

```ts
ws.onopen = () => {
  if (this.ws !== ws) return;
  ...
};
ws.onmessage = (msg) => {
  if (this.ws !== ws || typeof msg.data !== "string") return;
  ...
};
ws.onclose = () => {
  if (this.ws !== ws) return;
  ...
};
```

And a test in `shared.test.ts`: with a fake `WebSocket`, call `connect()`, `close()`, `connect()`, then fire the first socket's `close` event; `send()` should still go through the second socket, and no reconnect should be scheduled.
