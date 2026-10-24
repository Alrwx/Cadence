// Package config reads gateway settings from the environment (see .env.example).
package config

import (
	"os"
	"path/filepath"
)

type Config struct {
	Addr      string // GATEWAY_ADDR
	ModelsURL string // MODELS_URL, always a 127.0.0.1 address
	DataDir   string // DATA_DIR: SQLite db and clip cache
	TLSCert   string
	TLSKey    string
	WebRoot   string // built apps: <WebRoot>/headset/dist, <WebRoot>/phone/dist
}

func Load() Config {
	return Config{
		Addr:      env("GATEWAY_ADDR", ":8443"),
		ModelsURL: env("MODELS_URL", "http://127.0.0.1:8000"),
		DataDir:   env("DATA_DIR", "./data"),
		TLSCert:   env("TLS_CERT", "./certs/dev.pem"),
		TLSKey:    env("TLS_KEY", "./certs/dev-key.pem"),
		WebRoot:   env("WEB_ROOT", "./apps"),
	}
}

func (c Config) DBPath() string   { return filepath.Join(c.DataDir, "cadence.db") }
func (c Config) ClipsDir() string { return filepath.Join(c.DataDir, "clips") }

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
