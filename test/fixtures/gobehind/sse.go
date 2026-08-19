package main

import "net/http"

// sseRegistrar is the router as this file sees it — an interface of its own, which is
// what stops the registration below from being read as a door and, with it, stops this
// file's wiring from being recognised as wiring.
type sseRegistrar interface {
	HandleFunc(pattern string, handler http.HandlerFunc)
}

// RegisterSSERoutes is handed the mux to register *on*, not to stand in front of. Its
// handler answers a missing token with a 401, which is enough to make the registrar
// itself read as a function that turns callers away. memos writes exactly this, and it
// went in front of two routes it has nothing to do with.
func RegisterSSERoutes(router sseRegistrar, hub string, secret string) {
	router.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		streamEvents(w, r, secret)
	})
}

func streamEvents(w http.ResponseWriter, r *http.Request, secret string) {
	if r.Header.Get("Authorization") != secret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.WriteHeader(http.StatusOK)
}
