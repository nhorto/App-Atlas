// Package admin hangs its doors on a router somebody else built.
package admin

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// RegisterRoutes writes the admin doors onto the router it is handed.
func RegisterRoutes(r chi.Router) {
	r.Get("/admin/status", status)
}

// status says whether the gateway is healthy.
func status(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
