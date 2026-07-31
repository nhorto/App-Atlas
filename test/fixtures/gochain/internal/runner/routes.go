// Package runner is what a build agent registers itself against.
package runner

import (
	"net/http"

	"github.com/example/depot/internal/web"
)

// Routes builds the router the gateway hangs under a prefix of its own.
func Routes(prefix string) *web.Router {
	m := web.NewRouter()
	m.Get("/register", register)
	return m
}

// register signs a build agent in.
func register(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
