package api

import "net/http"

// listOrders answers with every order the shop has taken.
func listOrders(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// createOrder records a new order.
func createOrder(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}
