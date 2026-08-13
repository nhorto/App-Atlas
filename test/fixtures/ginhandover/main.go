// The shape real Gin code writes (#194): the group is built *in the argument*, so there
// is no router variable for a rule to match on — and the whole of the realworld example
// is wired this way.
//
// The ordering is the other half, and it is not decoration. `Group()` copies the host's
// middleware as it runs, so `/api/users` — made on the line before the first `Use` —
// is public, and it has to be, because it is where sessions are handed out.
package main

import (
	"github.com/example/ginhandover/admin"
	"github.com/example/ginhandover/articles"
	"github.com/example/ginhandover/users"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()

	v1 := r.Group("/api")
	users.UsersRegister(v1.Group("/users"))

	v1.Use(users.AuthMiddleware(false))
	articles.ArticlesAnonymousRegister(v1.Group("/articles"))

	v1.Use(users.AuthMiddleware(true))
	articles.ArticlesRegister(v1.Group("/articles"))

	admin.AdminRegister(v1.Group("/admin"))

	r.GET("/api/ping", Ping)
	r.Run(":8080")
}

func Ping(c *gin.Context) {
	c.JSON(200, gin.H{"pong": true})
}
