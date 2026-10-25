#!/usr/bin/env bash
# Run the Cadence stack on pserver as systemd user services. See deploy/README.md.
#
#   deploy/cadence.sh install          render + enable the units, then deploy
#   deploy/cadence.sh deploy           rebuild the apps and gateway, restart gateway + model service
#   deploy/cadence.sh deploy gateway   same, but leave the model service running (web or gateway changes only)
#   deploy/cadence.sh status | logs [ollama|models|gateway] | start | stop | restart | certs | uninstall
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(cadence-ollama cadence-models cadence-gateway)
BACKEND="${BACKEND:-cuda}"
GATEWAY_PORT=8443

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
sysd() { systemctl --user "$@"; }

find_bin() { # find_bin <name> <fallback glob>: PATH first, then the no-sudo installs under ~/.local
	command -v "$1" 2>/dev/null && return
	local hit
	hit="$(compgen -G "$2" | sort -V | tail -n 1)" || true
	[[ -n "$hit" ]] && echo "$hit"
}

ts_dns() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true; }

# A port held by something other than our unit (an old `make dev`, a hand-started `ollama serve`) makes the unit
# crash-loop on "address in use", so stop early and say what holds it.
check_port() { # check_port <port> <unit>
	sysd is-active --quiet "$2" && return
	local holder
	holder="$(ss -ltnpH "sport = :$1" 2>/dev/null)" || true
	[[ -z "$holder" ]] && return
	die "port $1 is already in use, so $2 can't start. Stop that process first:
  $holder"
}

cmd_install() {
	local uv ollama
	uv="$(find_bin uv "$HOME/.local/bin/uv")" || true
	ollama="${OLLAMA_BIN:-$(find_bin ollama "$HOME/.local/opt/ollama-*/bin/ollama")}" || true
	[[ -x "$uv" ]] || die "uv not found (https://docs.astral.sh/uv/)"
	[[ -x "$ollama" ]] || die "ollama not found; install it or set OLLAMA_BIN=/path/to/ollama"
	command -v pnpm >/dev/null || die "pnpm not found"
	command -v go >/dev/null || die "go not found"
	[[ -f "$REPO/certs/dev.pem" ]] || cmd_certs

	say "Installing units into $UNIT_DIR (uv=$uv, ollama=$ollama, backend=$BACKEND)"
	mkdir -p "$UNIT_DIR"
	for u in "${UNITS[@]}"; do
		sed -e "s|@REPO@|$REPO|g" -e "s|@UV@|$uv|g" -e "s|@OLLAMA@|$ollama|g" -e "s|@BACKEND@|$BACKEND|g" \
			"$REPO/deploy/systemd/$u.service" >"$UNIT_DIR/$u.service"
	done
	sysd daemon-reload
	sysd enable "${UNITS[@]/%/.service}"

	if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
		echo "note: linger is off, so the services stop when your last login session on this machine ends."
		echo "      To keep them up (and start them at boot): sudo loginctl enable-linger $USER"
	fi
	cmd_deploy all
}

build() {
	say "Building headset + phone"
	(cd "$REPO" && pnpm install --frozen-lockfile && pnpm --filter @cadence/headset --filter @cadence/phone build)
	say "Building gateway"
	(cd "$REPO/services/gateway" && go build -o bin/gateway ./cmd/gateway)
}

cmd_deploy() {
	local what="${1:-all}"
	[[ "$what" == all || "$what" == gateway ]] || die "deploy takes 'all' or 'gateway', not '$what'"
	[[ -f "$UNIT_DIR/cadence-gateway.service" ]] || die "units not installed; run: deploy/cadence.sh install"
	build
	check_port 11434 cadence-ollama
	check_port 8000 cadence-models
	check_port "$GATEWAY_PORT" cadence-gateway
	say "Starting Ollama (waits for Gemma to load)"
	sysd start cadence-ollama
	if [[ "$what" == all ]]; then
		say "Restarting model service"
		sysd restart cadence-models
	else
		sysd start cadence-models
	fi
	say "Restarting gateway"
	sysd restart cadence-gateway
	wait_ready
	cmd_status
}

wait_ready() { # the model service answers right away and loads in the background; wait for all three models
	local health=""
	printf 'Waiting for models'
	for _ in $(seq 1 120); do
		health="$(curl -sf http://127.0.0.1:8000/health 2>/dev/null)" || true
		if [[ "$health" == *'"stt":"ready"'* && "$health" == *'"suggest":"ready"'* && "$health" == *'"tts":"ready"'* ]]; then
			echo " ready"
			return
		fi
		printf '.'
		sleep 3
	done
	echo " still not ready after 6 min: ${health:-no answer}. Check: deploy/cadence.sh logs models"
}

cmd_status() {
	for u in "${UNITS[@]}"; do printf '%-16s %s\n' "$u" "$(sysd is-active "$u" 2>/dev/null || true)"; done
	printf '%-16s %s\n' "models /health" "$(curl -sf http://127.0.0.1:8000/health 2>/dev/null || echo unreachable)"
	printf '%-16s %s\n' "gateway /healthz" "$(curl -skf "https://127.0.0.1:$GATEWAY_PORT/healthz" 2>/dev/null || echo unreachable)"
	echo
	echo "Open (add ?session=<id> to pair a headset with a phone; default demo):"
	local dns ip
	dns="$(ts_dns)"
	ip="$(tailscale ip -4 2>/dev/null | head -n 1)" || true
	[[ -n "$dns" ]] && echo "  tailnet:  https://$dns:$GATEWAY_PORT/headset/   https://$dns:$GATEWAY_PORT/phone/"
	[[ -n "$dns" ]] && echo "  bench:    https://$dns:$GATEWAY_PORT/phone/test.html   (phone + stand-in headset, no Quest)"
	[[ -n "$ip" ]] && echo "  tailnet:  https://$ip:$GATEWAY_PORT/headset/"
	echo "  tunnel:   ssh -N -L $GATEWAY_PORT:localhost:$GATEWAY_PORT $USER@${dns:-$(hostname)}  then https://localhost:$GATEWAY_PORT/headset/"
}

cmd_logs() {
	if [[ -n "${1:-}" ]]; then
		journalctl --user -f -n 100 -u "cadence-$1"
	else
		journalctl --user -f -n 100 "${UNITS[@]/#/-u}"
	fi
}

cmd_certs() { # mkcert cert for every name a tester might use: localhost, the LAN IP, and the Tailscale IPs + name
	command -v mkcert >/dev/null || die "mkcert not found"
	local names=(localhost 127.0.0.1 ::1 "$(hostname)")
	read -r -a lan <<<"$(hostname -I 2>/dev/null)" || true
	[[ -n "${lan[0]:-}" ]] && names+=("${lan[0]}")
	if command -v tailscale >/dev/null; then
		while read -r ip; do [[ -n "$ip" ]] && names+=("$ip"); done < <(tailscale ip 2>/dev/null)
		local dns
		dns="$(ts_dns)"
		[[ -n "$dns" ]] && names+=("$dns")
	fi
	say "Writing certs/dev.pem for: ${names[*]}"
	mkdir -p "$REPO/certs"
	mkcert -cert-file "$REPO/certs/dev.pem" -key-file "$REPO/certs/dev-key.pem" "${names[@]}"
	echo "Trust it on a test device by installing $(mkcert -CAROOT)/rootCA.pem (see deploy/README.md)."
	if sysd is-active --quiet cadence-gateway; then sysd restart cadence-gateway; fi
}

cmd_warm_ollama() { # ExecStartPost of cadence-ollama: wait for the API, then load the suggestion model and keep it
	local url="http://127.0.0.1:11434" model="${SUGGEST_MODEL:-gemma4:e4b}"
	for _ in $(seq 1 60); do curl -sf "$url/api/version" >/dev/null && break; sleep 1; done
	curl -sf "$url/api/generate" -d "{\"model\":\"$model\",\"keep_alive\":-1}" >/dev/null ||
		echo "warning: couldn't load $model (is it pulled? ollama pull $model)" >&2
}

cmd_uninstall() {
	sysd disable --now "${UNITS[@]/%/.service}" 2>/dev/null || true
	for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u.service"; done
	sysd daemon-reload
	say "Removed the units. data/, certs/ and the built apps are untouched."
}

case "${1:-}" in
	install) cmd_install ;;
	deploy) cmd_deploy "${2:-all}" ;;
	status) cmd_status ;;
	logs) cmd_logs "${2:-}" ;;
	start) sysd start "${UNITS[@]}" && wait_ready && cmd_status ;;
	stop) sysd stop "${UNITS[@]}" ;;
	restart) sysd restart "${UNITS[@]}" && wait_ready && cmd_status ;;
	certs) cmd_certs ;;
	uninstall) cmd_uninstall ;;
	warm-ollama) cmd_warm_ollama ;;
	*) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
