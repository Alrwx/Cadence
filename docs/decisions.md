# Decisions

Append-only. One entry per decision: date, decision, why, who.

---

### 2026-10-24 – Quest 3S scaffold replaces the glasses scaffold
**Decision:** Removed the Ray-Ban Meta glasses scaffold (`apps/ios`, `apps/server`, `supabase`, `deploy`) and scaffolded the layout in `AGENTS(GH).md` §5: WebXR headset app, phone web app, Go gateway, Python model service, protocol package, mocks.
**Why:** The project moved to a Meta Quest 3S in passthrough; everything runs locally on the demo laptop.
**Who:** Alvin

### 2026-10-24 – Dev servers proxy to the gateway
**Decision:** The headset and phone Vite dev servers proxy `/ws` and `/clips` to the gateway (or the mock gateway via `GATEWAY_TARGET`), so the apps only use same-origin URLs in dev and in the built version the gateway serves.
**Why:** Avoids CORS and per-device URL config; the Quest and phone each accept one certificate.
**Who:** Alvin

### 2026-10-24 – Protocol codegen is a small in-repo script
**Decision:** `packages/protocol/scripts/generate.mjs` generates `ts/index.ts` and `go/events.go` from `schema/*.schema.json` (subset: objects, strings/enums, booleans, integers, arrays).
**Why:** No extra toolchain to install, and the schemas stay simple. Swap for a full generator if the schemas outgrow it.
**Who:** Alvin

### 2026-10-24 – Carry features over from the glasses design
**Decision:** Added to `AGENTS(GH).md` and the README: hands-free head-dwell selection and voice-sample recording on the phone (core, M3); starter saved-phrase groups, including the demo greeting; a clip cache keyed by voice, locale, and text; `locale` plumbing through the model service; quick memories and pointing at objects (stretch, M5). Contract changes are additive optional fields.
**Why:** These came out of the earlier glasses design and still fit the Quest 3S version. Head selection covers users who can't pinch; pointing at objects stays blocked until a spike gets camera frames out of Quest Browser.
**Who:** David
