package main

import "net/http"

// AdminConfig carries the mux the admin doors are hung on. A router held in a struct
// field is ordinary Go and was invisible until #129: the receiver of each registration
// below is `cfg.Mux`, which is neither a local built here nor a parameter typed as a
// router, so nothing matched it and tailscale/setec reported no HTTP doors at all.
type AdminConfig struct {
	Mux    *http.ServeMux
	Prefix string
}

// MountAdmin registers the admin doors on the mux the caller brought.
func MountAdmin(cfg AdminConfig) {
	cfg.Mux.HandleFunc("/admin/backup", handleBackup)
	cfg.Mux.HandleFunc("GET /admin/audit", handleAudit)
}

func handleBackup(w http.ResponseWriter, r *http.Request) {}

func handleAudit(w http.ResponseWriter, r *http.Request) {}
