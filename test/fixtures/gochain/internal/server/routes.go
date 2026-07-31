// Package server assembles the site out of the routers each package hands back, and is
// where every prefix in it is written.
package server

import (
	"net/http"

	"github.com/example/depot/internal/pipeline"
	"github.com/example/depot/internal/reports"
	"github.com/example/depot/internal/runner"
	"github.com/example/depot/internal/web"
)

// reportBase is declared once and named at the mount below, which is the ordinary way a
// prefix shared by a package and whatever links to it is written.
const reportBase = "/reports"

// Normal builds the router the process listens on.
func Normal() *web.Router {
	r := web.NewRouter()
	r.Get("/healthz", healthz)

	// One variable, reused for both halves of the runner API — so it holds two addresses
	// in one function and neither of them is the answer. The prefix is handed to the
	// package as well as mounting it, because a package that builds absolute links has to
	// know its own address.
	prefix := "/api/pipeline"
	r.Mount(prefix, pipeline.ArtifactRoutes(prefix))

	prefix = "/api/runner"
	r.Mount(prefix, runner.Routes(prefix))

	r.Mount(reportBase, reports.Routes())

	return r
}

// healthz says whether the process is up.
func healthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
