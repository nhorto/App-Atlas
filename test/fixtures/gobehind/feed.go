package main

import "net/http"

func NewFeedHandler() http.Handler {
	feedMux := http.NewServeMux()
	feedMux.HandleFunc("GET /feed.xml", showFeed)
	RegisterSSERoutes(feedMux, "hub", "s3cret")

	return feedMux
}

func showFeed(w http.ResponseWriter, r *http.Request) {}
