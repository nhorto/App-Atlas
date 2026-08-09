// The realworld shape (#151): groups handed into package functions, with the one
// ordering that makes the collision dangerous — users mounts before the auth
// middleware, articles after it. Whatever the map says about one of these POSTs must
// not be said about the other.
package main

import (
	"github.com/example/gingroups/articles"
	"github.com/example/gingroups/users"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	v1 := r.Group("/api")
	users.Routes(v1)
	v1.Use(users.AuthMiddleware())
	articles.Routes(v1)
	r.GET("/api/ping", Ping)
	r.Run(":8080")
}

// A complete address on the top-level engine: no prefix to find, and nothing to
// resolve. This door must keep its name exactly as written.
func Ping(c *gin.Context) {
	c.JSON(200, gin.H{"pong": true})
}
