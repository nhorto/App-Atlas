package main

import (
	"net/http"
	"os"
)

// middleware holds the API's checks. The routes it stands in front of are registered in
// api.go and this file is never mentioned on any of their lines.
type middleware struct {
	secret string
}

func newMiddleware() *middleware {
	return &middleware{secret: os.Getenv("API_SECRET")}
}

// withCORSHeaders adds headers and turns nobody away. It is attached by exactly the same
// call as the check below it, on the same line, and telling the two apart is the whole
// job.
func (m *middleware) withCORSHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		next.ServeHTTP(w, r)
	})
}

// validateBasicAuth answers 401 to anybody without credentials.
func (m *middleware) validateBasicAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user == "" || pass != m.secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
