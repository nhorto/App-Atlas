// Package api is the versioned surface of the gateway.
package api

import "github.com/go-chi/chi/v5"

// Routes builds the router the gateway hangs under its version prefix.
func Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/orders", listOrders)
	r.Post("/orders", createOrder)
	return r
}
