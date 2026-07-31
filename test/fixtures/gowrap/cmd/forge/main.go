// Command forge serves the whole site.
package main

import (
	"log"
	"net/http"

	"github.com/example/forge/internal/server"
)

func main() {
	log.Fatal(http.ListenAndServe(":8080", server.Normal()))
}
