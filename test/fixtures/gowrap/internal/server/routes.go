// Package server assembles the site out of the routers each package hands back.
package server

import (
	"net/http"

	"github.com/example/forge/internal/api"
	"github.com/example/forge/internal/packages"
	"github.com/example/forge/internal/web"
)

// Normal builds the router the process listens on, and is where every prefix in the
// site is written.
func Normal() *web.Router {
	r := web.NewRouter()
	r.Get("/healthz", healthz)
	r.Mount("/api/v1", api.Routes())
	r.Mount("/packages", packages.CommonRoutes())
	r.Mount("/v2", packages.ContainerRoutes())
	return r
}

// healthz says whether the process is up.
func healthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
