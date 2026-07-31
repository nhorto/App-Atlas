// Command gateway puts every version of the API behind the prefix it belongs under.
package main

import (
	"log"
	"net/http"

	"github.com/example/gateway/internal/admin"
	"github.com/example/gateway/internal/api"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()

	// The routes are built in another package, and the prefix they answer under is
	// written here and nowhere else.
	r.Mount("/api/v1", api.Routes())

	// The other way round: the parent router is handed over, so the addresses written
	// inside are already the whole address.
	admin.RegisterRoutes(r)

	log.Fatal(http.ListenAndServe(":8080", r))
}
