package main

import "net/http"

// Server keeps its checks in a field. `s.guard` is not built on any line this file can
// read, so which `handle` it is cannot be told from here — and a door had rather read
// open than name the wrong function as its lock.
type Server struct {
	guard *authProxy
}

func (s *Server) Handler() http.Handler {
	srvMux := http.NewServeMux()
	srvMux.HandleFunc("GET /status", showStatus)

	return s.guard.handle(srvMux)
}

func showStatus(w http.ResponseWriter, r *http.Request) {}

func main() {
	mux := http.NewServeMux()
	mux.Handle("/v1/", http.StripPrefix("/v1", NewAPIHandler()))
	_ = http.ListenAndServe(":8080", mux)
}
