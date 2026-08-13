package articles

import "github.com/gin-gonic/gin"

// Three functions, one parameter name. Whatever a group is called outside, in here it is
// `router` every time — so a rule that names the router after the file has one prefix
// for three sets of doors.
func ArticlesRegister(router *gin.RouterGroup) {
	router.POST("", ArticleCreate)
}

func ArticlesAnonymousRegister(router *gin.RouterGroup) {
	router.GET("/:slug", ArticleRetrieve)
}

func ArticleCreate(c *gin.Context)   { c.JSON(201, gin.H{}) }
func ArticleRetrieve(c *gin.Context) { c.JSON(200, gin.H{}) }
