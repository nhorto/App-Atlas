package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// A check with no switch on it, so a group behind it really is shut and says so.
func RequireAdmin(c *gin.Context) {
	if c.GetHeader("X-Admin") == "" {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}
	c.Next()
}

func AdminRegister(router *gin.RouterGroup) {
	router.Use(RequireAdmin)
	router.GET("/settings", AdminSettings)
}

func AdminSettings(c *gin.Context) { c.JSON(200, gin.H{}) }
