// Package packages serves two registries out of one file.
package packages

import (
	"net/http"

	"github.com/example/forge/internal/web"
)

// CommonRoutes serves the package managers.
func CommonRoutes() *web.Router {
	r := web.NewRouter()
	r.Get("/{name}/files", listFiles)
	r.Post("/{name}/files", upload)
	return r
}

// ContainerRoutes serves the container registry, which its own spec pins to a prefix of
// its own — so these two answer nowhere near each other, however alike the file looks.
func ContainerRoutes() *web.Router {
	r := web.NewRouter()
	r.Get("/token", token)
	return r
}

// listFiles lists what a package has published.
func listFiles(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// upload accepts a new file for a package.
func upload(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}

// token hands a container client the token it will authenticate with.
func token(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
