package users

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// The switch this whole rule is about: one function, attached twice, a lock only when
// the caller says so. The generic IR drops a nested call's arguments, so nothing here
// tells the two attachments apart.
func AuthMiddleware(auto401 bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			if auto401 {
				c.AbortWithStatus(http.StatusUnauthorized)
			}
			return
		}
		c.Next()
	}
}
