// Package web is this service's own router, wrapped around chi so that every package
// declares its doors the same way.
package web

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Router is what every part of this service registers its doors on.
type Router struct {
	chiRouter chi.Router
	prefix    string
}

// NewRouter builds an empty router.
func NewRouter() *Router {
	r := chi.NewRouter()
	return &Router{chiRouter: r}
}

// Get registers a door answering GET at pattern.
func (r *Router) Get(pattern string, h http.HandlerFunc) {
	r.chiRouter.Get(r.prefix+pattern, h)
}

// Post registers a door answering POST at pattern.
func (r *Router) Post(pattern string, h http.HandlerFunc) {
	r.chiRouter.Post(r.prefix+pattern, h)
}

// Group registers everything fn declares under a shared prefix.
func (r *Router) Group(pattern string, fn func()) {
	previous := r.prefix
	r.prefix += pattern
	fn()
	r.prefix = previous
}

// Mount hangs a router built elsewhere under a prefix of its own.
func (r *Router) Mount(pattern string, sub *Router) {
	r.chiRouter.Mount(pattern, sub.chiRouter)
}
