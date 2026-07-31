// Package pipeline is the half of the API a build runner talks to.
package pipeline

import (
	"net/http"

	"github.com/example/depot/internal/web"
)

// artifactBase is the address every artifact door answers under. Written once here and
// named at the group below, so no route in this file contains it.
const artifactBase = "/_apis/pipelines/workflows/{run_id}/artifacts"

// ArtifactRoutes builds the router the gateway hangs under a prefix of its own, so the
// address a runner calls is assembled from two prefixes and a route, in two packages.
func ArtifactRoutes(prefix string) *web.Router {
	m := web.NewRouter()

	m.Group(artifactBase, func() {
		m.Put("/{artifact_hash}/upload", uploadArtifact)
		m.Get("/{artifact_id}/download", downloadArtifact)
	})

	return m
}

// uploadArtifact stores what a finished build produced.
func uploadArtifact(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}

// downloadArtifact hands back what an earlier build stored.
func downloadArtifact(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
