// Command tiny is an HTTP service with no dependencies at all.
package main

import (
	"encoding/json"
	"expvar"
	"net/http"
	"os"
)

// requireToken turns away callers without the shared secret.
func requireToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Token") != os.Getenv("API_TOKEN") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// health answers whether the process is up.
func health(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// createWidget records a widget.
func createWidget(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("POST /widgets", requireToken(createWidget))
	mux.Handle("/debug/vars", expvar.Handler())

	_ = http.ListenAndServe(":"+os.Getenv("PORT"), mux)
}
