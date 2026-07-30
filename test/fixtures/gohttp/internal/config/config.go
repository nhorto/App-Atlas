// Package config reads the settings this service is given at boot.
package config

import "os"

// Config is everything the service is told at startup.
type Config struct {
	DatabaseURL string
	Port        string
}

// Load reads the environment once, at the top of main.
func Load() Config {
	return Config{
		DatabaseURL: os.Getenv("DATABASE_URL"),
		Port:        os.Getenv("PORT"),
	}
}
