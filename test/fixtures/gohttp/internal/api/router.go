// Package api wires every HTTP door this service opens.
package api

import (
	"net/http"

	"github.com/example/shop/internal/store"
	"github.com/go-chi/chi/v5"
)

// Server answers requests, backed by the order store.
type Server struct {
	Orders *store.Orders
}

// NewRouter builds the router the service listens on.
func NewRouter(s *Server) http.Handler {
	r := chi.NewRouter()
	r.Use(Logger)
	r.Get("/health", s.Health)

	r.Route("/orders", func(r chi.Router) {
		r.Get("/", s.ListOrders)
		r.With(RequireAuth).Post("/", s.CreateOrder)
	})

	r.Group(func(r chi.Router) {
		r.Use(RequireAuth)
		r.Delete("/admin/orders/{id}", s.DeleteOrder)
	})

	return r
}

// Health says the service is up.
func (s *Server) Health(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// ListOrders returns every order the shop has taken.
func (s *Server) ListOrders(w http.ResponseWriter, r *http.Request) {
	_, _ = s.Orders.All(r.Context())
}

// CreateOrder records a new order.
func (s *Server) CreateOrder(w http.ResponseWriter, r *http.Request) {
	_ = s.Orders.Insert(r.Context(), "pending")
}

// DeleteOrder removes an order for good.
func (s *Server) DeleteOrder(w http.ResponseWriter, r *http.Request) {
	_ = s.Orders.Delete(r.Context(), chi.URLParam(r, "id"))
}
