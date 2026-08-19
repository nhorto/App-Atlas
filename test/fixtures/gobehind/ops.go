package main

import "net/http"

// requireOperator is a plain function rather than a method, which is the other half of
// the wrap shape and the half that needs no constructor to name it.
func requireOperator(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Operator") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func NewOpsHandler() http.Handler {
	opsMux := http.NewServeMux()
	opsMux.HandleFunc("GET /ops/queue", showQueue)

	return requireOperator(opsMux)
}

func showQueue(w http.ResponseWriter, r *http.Request) {}
