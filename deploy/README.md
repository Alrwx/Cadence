# Deploying Cadence on pserver

This runs the whole stack on pserver (the RTX 3080 box) as three systemd user services. You don't need a terminal running `make dev`, and testers open one URL from any device on the tailnet.

| Service           | What it runs                                                                                 | Address                        |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| `cadence-ollama`  | Ollama with Gemma loaded and kept in memory                                                  | `127.0.0.1:11434` (local only) |
| `cadence-models`  | `services/models` on the CUDA backend                                                        | `127.0.0.1:8000` (local only)  |
| `cadence-gateway` | `services/gateway`: `/ws`, `/api`, `/clips`, and the built apps at `/headset/` and `/phone/` | `:8443` (HTTPS)                |

The services start in that order. `cadence-ollama` loads Gemma before the model service starts, because on the 10 GB card Gemma only fits fully on the GPU if it loads before TTS. Restarting Ollama restarts the model service too, so the order holds.

Everything is driven by `deploy/cadence.sh`:

```sh
deploy/cadence.sh install          # one time: install + enable the units, then deploy
deploy/cadence.sh deploy           # rebuild apps + gateway, restart gateway and model service
deploy/cadence.sh deploy gateway   # web or gateway changes only: leaves the models loaded
deploy/cadence.sh status           # what's up, model readiness, URLs to open
deploy/cadence.sh logs [ollama|models|gateway]
deploy/cadence.sh start | stop | restart
deploy/cadence.sh certs            # regenerate the HTTPS cert (e.g. after an IP change)
deploy/cadence.sh uninstall
```

## One-time setup

All of this runs on pserver.

1. **Tools.** You need Node 22+ with pnpm, Go 1.26+, [uv](https://docs.astral.sh/uv/), [mkcert](https://github.com/FiloSottile/mkcert), and [Ollama](https://ollama.com). None of them need sudo; user installs under `~/.local` are fine. If Ollama isn't on `PATH`, the script finds `~/.local/opt/ollama-*/bin/ollama`, or you can set `OLLAMA_BIN=/path/to/ollama`.

2. **Dependencies and models.**

   ```sh
   cp -n .env.example .env
   pnpm install
   (cd services/models && uv sync --extra cuda)   # plain `uv sync` removes torch
   (cd services/gateway && go mod download)
   ollama pull gemma4:e4b
   ```

   The services read `.env`, but the deploy always uses the CUDA backend, the real models, and `<repo>/data`, whatever `.env` says. `DEV_TOOLS=1` (the default) keeps the phone's "type for the listener" feature on. Set `DEV_TOOLS=0` in `.env` for a real demo.

3. **Stop anything you started by hand.** That means an old `make dev`, `make models`, `make gateway`, or a manual `ollama serve`. If one of them still holds port 8000, 11434, or 8443, `install` stops and tells you which process it is:

   ```sh
   ss -ltnp 'sport = :8000 or sport = :11434 or sport = :8443'
   kill <pid>    # for each one listed
   ```

4. **Install.**

   ```sh
   deploy/cadence.sh install
   ```

   This builds both apps and the gateway, creates `certs/dev.pem` if it's missing, starts the services, waits until STT, suggestions, and TTS all report `ready`, and prints the URLs.

5. **Keep it running after you log out (optional, needs sudo once).** User services stop when your last login session on pserver ends. To keep them up and have them start at boot:

   ```sh
   sudo loginctl enable-linger pserver
   ```

## Everyday use

```sh
git switch <branch> && git pull
deploy/cadence.sh deploy            # changed services/models: restarts it; waits for the models to reload
deploy/cadence.sh deploy gateway    # changed apps/ or services/gateway only: quick
```

Then reload the page on the test device. `deploy` waits for the models and finishes by printing `status`.

## Using a real voice as the default

Anyone who hasn't recorded a sample hears the built-in "default" voice, a synthetic clip in `services/models/assets/`. To make it a real person's voice on pserver only, without committing the recording:

1. Record the person reading a short passage, 10–30 s, in a quiet room. Copy the file to pserver.
2. Convert it. The transcript has to match the recording word for word:

   ```sh
   cd services/models
   uv run --extra cuda python scripts/set_default_voice.py ~/clip.m4a --text "Exactly what they said." --out ../../data/default_voice
   ```

3. Add the two lines it prints (`DEFAULT_VOICE_AUDIO`, `DEFAULT_VOICE_TEXT`) to `.env`, then run `systemctl --user restart cadence-models`.

To go back to the synthetic voice, clear those two lines and restart again. Keep earlier recordings in their own folders under `data/` if you might switch back.

## Opening it from a test device

`deploy/cadence.sh status` prints the exact URLs. On the tailnet they are:

- Headset: `https://debian.tailbcbf3f.ts.net:8443/headset/?session=demo`
- Phone: `https://debian.tailbcbf3f.ts.net:8443/phone/?session=demo`
- Test bench (no Quest needed): `https://debian.tailbcbf3f.ts.net:8443/phone/test.html`. This is the phone page next to a clickable stand-in headset, and you can type what the listener said. Typing needs `DEV_TOOLS=1`, which is the default. It runs on session `testbench`, not `demo`: on the real devices' session it would take over their connections. Language and the cloned voice are shared by every session, so changing them on the bench changes them on the real devices too.

Use the same `?session=<id>` on both to pair them; it defaults to `demo`. Pick your own id if someone else is testing at the same time.

**Getting rid of the certificate warning.** The cert is signed by the mkcert CA on pserver. It covers `localhost`, `debian`, `debian.tailbcbf3f.ts.net`, the Tailscale IPs, and the LAN IP. Install the CA once on each device and the warning goes away:

```sh
scp pserver@debian.tailbcbf3f.ts.net:.local/share/mkcert/rootCA.pem .
```

- **Mac:** double-click `rootCA.pem`, then in Keychain Access open it and set _Trust → Always Trust_.
- **iPhone:** AirDrop or email the file, install the profile in _Settings → General → VPN & Device Management_, then turn it on under _Settings → General → About → Certificate Trust Settings_.
- **Android:** _Settings → Security → Encryption & credentials → Install a certificate → CA certificate_.
- **Quest:** there's no practical way to install a CA, so accept the warning once in Quest Browser.

Keep `rootCA.pem` to the team: anyone with the matching key (on pserver only) can mint certs those devices trust. Never copy `rootCA-key.pem`.

**Devices that aren't on the tailnet.**

- **Desktop headset emulator.** The Immersive Web Emulator only loads on `localhost`, so tunnel from your laptop and open `https://localhost:8443/headset/`:

  ```sh
  ssh -N -L 8443:localhost:8443 pserver@debian.tailbcbf3f.ts.net
  ```

- **Quest or phone on the hotspot.** These can't reach pserver directly. Forward the Mac's port to it, then open `https://[<mac-ipv6>]:8443/headset/` on the Quest and accept the warning:

  ```sh
  ssh -N -L '*:8443:localhost:8443' pserver@100.69.215.83
  ```

  Alternatively, install the Tailscale app on the phone and use the tailnet URL.

## Troubleshooting

| Symptom                                                     | Fix                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port 8000 is already in use`                               | Something started by hand still holds the port. Kill the PID it prints and run `deploy` again.                                                                                                                                                |
| Status shows `models /health` stuck on `loading` or `error` | Run `deploy/cadence.sh logs models`. "Ollama not ready" errors retry on their own. Anything else is a real load failure.                                                                                                                      |
| Suggestions got slow (~850 ms instead of ~380 ms)           | Gemma reloaded after TTS and only partly fits on the GPU. Check `deploy/cadence.sh logs ollama` for `offloaded N/43`; anything under 43 means this. Run `systemctl --user restart cadence-ollama`, which restarts the model service after it. |
| TTS runs out of CUDA memory                                 | Something else is using the GPU (`nvidia-smi`). Stop it and run `deploy/cadence.sh restart`.                                                                                                                                                  |
| Cert warning even with the CA installed                     | You're using a name or IP the cert doesn't cover, e.g. after an IP change. Run `deploy/cadence.sh certs`; it restarts the gateway with the new cert.                                                                                          |
| `gateway /healthz` says the model service is unreachable    | The gateway is up but the model service isn't. Run `deploy/cadence.sh logs models`.                                                                                                                                                           |

The services log to the user journal: `journalctl --user -u cadence-gateway --since "10 min ago"`.

To remove everything, run `deploy/cadence.sh uninstall`. It disables and deletes the units and leaves `data/`, `certs/`, and the builds alone.
