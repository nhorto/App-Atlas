// Package api is the versioned surface of the forge.
package api

import (
	"net/http"

	"github.com/example/forge/internal/cache"
	"github.com/example/forge/internal/web"
)

// Routes builds the router the site hangs under its version prefix.
//
// The router is this repo's own type rather than chi's, which is the ordinary shape once
// a service is big enough to want its own way of declaring a route. Nothing in this file
// names a router library, and the prefix these addresses answer under is written in
// another package entirely.
func Routes() *web.Router {
	r := web.NewRouter()

	// An ordinary constructor, in the same function, spelled exactly the way a router's
	// is. A cache key is not an address, and `New()` is not evidence of anything.
	warm := cache.New()
	warm.Get("orders:recent")

	r.Get("/version", version)

	r.Group("/orders", func() {
		r.Get("/", listOrders)
		r.Post("/", createOrder)
	})

	return r
}

// version says which build is answering.
func version(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("1.0.0"))
}

// listOrders returns every order the forge has taken.
func listOrders(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// createOrder records a new order.
func createOrder(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}
