package articles

import "github.com/gin-gonic/gin"

func Routes(r *gin.RouterGroup) {
	r.POST("", ArticlesCreate)
}

// Mounted after v1.Use(AuthMiddleware) — requires a session. If this door and the
// users POST ever merge, one of them wears the other's truth.
func ArticlesCreate(c *gin.Context) {
	c.JSON(201, gin.H{"article": "created"})
}
