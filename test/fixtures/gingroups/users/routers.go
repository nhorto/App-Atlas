package users

import "github.com/gin-gonic/gin"

func Routes(r *gin.RouterGroup) {
	r.POST("", UsersRegister)
}

// Mounted before any Use — how you sign up. Deliberately open.
func UsersRegister(c *gin.Context) {
	c.JSON(201, gin.H{"user": "created"})
}

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatusJSON(401, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}
