# Cadence dev commands. Run from the repo root on the demo MacBook (macOS/Linux shell).
# Needs: Node 22+ with pnpm (corepack enable), Go 1.26+, uv, mkcert.

SHELL := /bin/bash
-include .env
export

LAN_IP ?= $(shell ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}')
MODELS_DIR := $(if $(filter 1,$(USE_MOCK_MODELS)),mocks/mock-models,services/models)
MODELS_APP := $(if $(filter 1,$(USE_MOCK_MODELS)),mock_models:app,app.main:app)

.PHONY: setup certs protocol dev dev-mock gateway models headset phone mock-gateway build demo \
	test test-protocol test-gateway test-models test-shared test-headset typecheck fmt

setup: ## Install all dependencies
	pnpm install
	cd services/models && uv sync
	cd mocks/mock-models && uv sync
	cd services/gateway && go mod download

certs: ## Local HTTPS certs for the laptop's LAN IP (accept the warning once on the Quest and phone)
	mkdir -p certs
	mkcert -cert-file certs/dev.pem -key-file certs/dev-key.pem $(LAN_IP) localhost 127.0.0.1

protocol: ## Regenerate TS + Go types from packages/protocol/schema
	pnpm protocol:gen

dev: ## Everything: model service (or mock if USE_MOCK_MODELS=1), gateway, headset, phone
	trap 'kill 0' EXIT; \
	$(MAKE) models & $(MAKE) gateway & \
	GATEWAY_TARGET=https://localhost:8443 $(MAKE) headset & \
	GATEWAY_TARGET=https://localhost:8443 $(MAKE) phone & \
	wait

dev-mock: ## Frontends only, against the scripted mock gateway (SCENARIO=happy-path|slow-tts|disconnect)
	trap 'kill 0' EXIT; \
	$(MAKE) mock-gateway & \
	GATEWAY_TARGET=https://localhost:8444 $(MAKE) headset & \
	GATEWAY_TARGET=https://localhost:8444 $(MAKE) phone & \
	wait

gateway:
	cd services/gateway && WEB_ROOT=../../apps TLS_CERT=../../certs/dev.pem TLS_KEY=../../certs/dev-key.pem \
		DATA_DIR=../../data go run ./cmd/gateway

models:
	cd $(MODELS_DIR) && uv run uvicorn $(MODELS_APP) --host 127.0.0.1 --port 8000

headset:
	pnpm --filter @cadence/headset dev

phone:
	pnpm --filter @cadence/phone dev

mock-gateway:
	pnpm --filter @cadence/mock-gateway start

build: ## Build both web apps so the gateway can serve them at /headset/ and /phone/
	pnpm --filter @cadence/headset --filter @cadence/phone build

demo: build ## Demo mode: real models, gateway serving built apps on https://$(LAN_IP):8443
	trap 'kill 0' EXIT; USE_MOCK_MODELS=0 $(MAKE) models & $(MAKE) gateway & wait

test: test-protocol test-gateway test-models test-shared test-headset ## All tests

test-protocol: ## Contract tests: every example parses in TS and Go
	pnpm --filter @cadence/protocol test
	cd packages/protocol/go && go test ./...

test-gateway:
	cd services/gateway && go vet ./... && go test ./...

test-models:
	cd services/models && uv run ruff check . && uv run ruff format --check . && uv run pytest

test-shared:
	pnpm --filter @cadence/shared test

test-headset:
	pnpm --filter @cadence/headset test

typecheck:
	pnpm typecheck

fmt:
	pnpm format
	cd services/gateway && gofmt -w .
	cd services/models && uv run ruff format .
