package main

import "net/http"

// NewAPIHandler registers the API and hands back the mux with the checks wrapped round
// it. Nothing is attached to the router: the router is the argument.
func NewAPIHandler() http.Handler {
	mw := newMiddleware()

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /v1/entries", listEntries)
	apiMux.HandleFunc("POST /v1/entries", createEntry)
	apiMux.HandleFunc("DELETE /v1/entries/{id}", removeEntry)

	return mw.withCORSHeaders(mw.validateBasicAuth(apiMux))
}

func listEntries(w http.ResponseWriter, r *http.Request) {}

func createEntry(w http.ResponseWriter, r *http.Request) {}

func removeEntry(w http.ResponseWriter, r *http.Request) {}
