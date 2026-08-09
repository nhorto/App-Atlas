package main

import (
	"github.com/example/gosignin/users"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	api := r.Group("/api")
	users.Routes(api)
	r.Run(":8080")
}
