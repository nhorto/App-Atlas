package main

import "net/http"

// sessionMiddleware sends a signed-out caller to the login page. A redirect is not a
// refusal — App Atlas does not read one as a check — so the doors behind this must stay
// blank however plainly the name reads.
type sessionMiddleware struct {
	basePath string
}

func newSessionMiddleware() *sessionMiddleware {
	return &sessionMiddleware{basePath: "/"}
}

func (m *sessionMiddleware) handle(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") == "" {
			http.Redirect(w, r, m.basePath+"login", http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// csrfMiddleware checks a token on writes and answers 400, not 401.
type csrfMiddleware struct{}

func newCSRFMiddleware() *csrfMiddleware {
	return &csrfMiddleware{}
}

func (m *csrfMiddleware) handle(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.FormValue("csrf") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// NewUIHandler is the API's shape written with names that collide. Neither `handle` here
// turns a caller away; the one in authproxy.go does.
func NewUIHandler() http.Handler {
	session := newSessionMiddleware()
	csrf := newCSRFMiddleware()

	uiMux := http.NewServeMux()
	uiMux.HandleFunc("GET /feeds", showFeeds)
	uiMux.HandleFunc("POST /feeds", saveFeed)

	return session.handle(csrf.handle(uiMux))
}

func showFeeds(w http.ResponseWriter, r *http.Request) {}

func saveFeed(w http.ResponseWriter, r *http.Request) {}
