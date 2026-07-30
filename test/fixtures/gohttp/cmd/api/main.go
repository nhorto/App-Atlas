// Command api serves the shop's HTTP API.
package main

import (
	"database/sql"
	"log"
	"net/http"

	"github.com/example/shop/internal/api"
	"github.com/example/shop/internal/config"
	"github.com/example/shop/internal/store"

	_ "github.com/lib/pq"
)

func main() {
	cfg := config.Load()

	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	srv := &api.Server{Orders: store.New(db)}
	log.Fatal(http.ListenAndServe(":"+cfg.Port, api.NewRouter(srv)))
}
