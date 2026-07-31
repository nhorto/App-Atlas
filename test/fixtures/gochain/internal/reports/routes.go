// Package reports is what an operator reads rather than what a runner calls.
package reports

import (
	"net/http"

	"github.com/example/depot/internal/web"
)

// Routes builds the router the gateway hangs under the reports prefix.
func Routes() *web.Router {
	r := web.NewRouter()
	r.Get("/daily", daily)
	return r
}

// daily hands back yesterday's numbers.
func daily(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
