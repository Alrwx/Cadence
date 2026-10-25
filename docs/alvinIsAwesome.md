# Running Cadence on localhost

How to get the headset, phone, and gateway running on your own machine with real models. The short version of the README's "Running locally", plus the parts it doesn't cover: where the models actually run, and the SSH tunnel to the 3080.

## What runs where

```
Browser (desktop emulator, Quest, or phone)
  │  https://localhost:5173/headset/    https://localhost:5174/phone/
  ▼
Vite dev servers (your machine)
  │  proxy /ws, /clips, /api → https://localhost:8443
  ▼
Go gateway (your machine, :8443)
  │  SQLite + clip cache in <worktree>/data
  │  MODELS_URL = http://127.0.0.1:8000
  ▼
Whatever is listening on 127.0.0.1:8000:
  • an SSH tunnel to the model service on Paolo's RTX 3080 (real models), or
  • mocks/mock-models (canned responses), or
  • services/models on the demo MacBook (real models, fully local)
```

The gateway only ever talks to `127.0.0.1:8000`. Where the models run is decided entirely by what you put on that port. The dev build and the built app (`make demo`) work the same way.

| Port | Service |
|---|---|
| 5173 | Headset dev server |
| 5174 | Phone dev server |
| 8443 | Gateway (HTTPS + WebSocket) |
| 8444 | Mock gateway (only with `make dev-mock`) |
| 8000 | Model service, localhost only (tunnel, mock, or real) |

## One-time setup

Needs Node 22+ (`corepack enable` for pnpm), Go 1.26+ on your `PATH`, [uv](https://docs.astral.sh/uv/), and [mkcert](https://github.com/FiloSottile/mkcert).

```sh
cp .env.example .env
make setup    # JS, Python, and Go dependencies
make certs    # HTTPS cert for localhost and this machine's LAN IP
```

HTTPS is required: WebXR and the phone's microphone don't work on plain HTTP off localhost.

## Pick a model source

### A. Real models on the 3080 (what we use day to day)

1. Ask Paolo for SSH access to the 3080 (your key on the server, and the server's Tailscale address). Check that its model service and Ollama are running there.
2. Open the tunnel and leave it running:

   ```sh
   ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
     -L 8000:127.0.0.1:8000 <user>@<3080-tailscale-ip>
   ```

3. Check it:

   ```sh
   curl -s http://127.0.0.1:8000/health
   # {"stt":"ready","suggest":"ready","tts":"ready","backend":"cuda"}
   ```

With the tunnel up, **don't run `make models` or `make dev`**. Both start a model service on port 8000, which the tunnel already holds. Start the gateway and the two frontends yourself (below).

Audio and transcripts go to the 3080 over the tunnel. That's our own machine, not a third-party API, but it does leave the laptop.

### B. Mock models (no GPU, no network)

```sh
USE_MOCK_MODELS=1 make models
```

Canned transcripts, suggestions, summaries, and beeps. Good for UI and gateway work; nothing it says is real.

### C. Real models on the demo MacBook (fully local)

Needs the M4 Pro. Ollama must be running with `gemma4:e4b` pulled (`ollama pull gemma4:e4b`, then `ollama serve`):

```sh
USE_MOCK_MODELS=0 MODELS_BACKEND=mlx make models
```

A laptop without a big GPU can't run the real models: all three need about 8–10 GB together.

## Start it

One terminal each:

```sh
make gateway
make headset
make phone
```

(With option B or C, `make dev` starts all four, models included, in one terminal. `USE_MOCK_MODELS` in `.env` picks mock (`1`, the default) or real (`0`).)

Check the gateway can reach the models:

```sh
curl -sk https://localhost:8443/healthz
# {"models":"cuda"}   (or "mock" / "mlx")
```

## Open it

- **Headset:** https://localhost:5173/headset/?session=demo. On a desktop browser, a Quest emulator loads automatically on `localhost`.
- **Phone:** https://localhost:5174/phone/?session=demo. Tap **Start** so audio can play.

Accept the certificate warning once in each browser. Both pages need the same `?session=` to pair (it defaults to `demo`).

**On a real Quest or phone:** join the same Wi-Fi as the laptop and use `https://<laptop-ip>:5173/headset/` and `https://<laptop-ip>:5174/phone/`. Over USB, `adb reverse tcp:5173 tcp:5173` lets the Quest use `https://localhost:5173/headset/`. On WSL2, other devices can't reach WSL's ports by default; turn on mirrored networking or forward the ports from Windows.

## When something's off

- **"Address already in use" on 8443, 5173, or 5174:** another worktree is already serving it. `ss -ltnp | grep -E ':(8443|5173|5174)'` shows which process. Only one gateway can hold 8443, and the dev servers proxy to whichever one does.
- **No captions or suggestions, but instant phrases still play:** the model service is unreachable, usually because the tunnel dropped. Check `curl http://127.0.0.1:8000/health` and reopen the tunnel.
- **Your cloned voice or saved phrases are missing:** each worktree has its own `data/` folder, so a gateway started from a different worktree has a different database. Point `DATA_DIR` at the folder you want.
- **Frontend-only work, no backend at all:** `make dev-mock` runs both frontends against the scripted mock gateway on 8444.
