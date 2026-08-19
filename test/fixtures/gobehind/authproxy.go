package main

import "net/http"

// authProxy is the reverse-proxy check: it answers 403 when the proxy names a user this
// server does not know. It stands in front of nothing in this fixture, which is the
// point of it — its method is called `handle`, and so are the two in ui.go that stand in
// front of everything.
type authProxy struct {
	header string
}

func newAuthProxy() *authProxy {
	return &authProxy{header: "X-Forwarded-User"}
}

func (m *authProxy) handle(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(m.header) == "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
