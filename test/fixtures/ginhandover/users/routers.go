package users

import "github.com/gin-gonic/gin"

func UsersRegister(router *gin.RouterGroup) {
	router.POST("", UsersRegistration)
	router.POST("/login", UsersLogin)
}

// Never handed a group by anybody. Its prefix is decided by a caller that does not
// exist in this repo, so its doors must keep the ellipsis rather than print their
// fragment as a whole address — #151's net, which a composition change must not
// quietly switch off.
func OrphanRegister(router *gin.RouterGroup) {
	router.GET("/orphan", Orphan)
}

func UsersRegistration(c *gin.Context) { c.JSON(201, gin.H{}) }
func UsersLogin(c *gin.Context)        { c.JSON(200, gin.H{}) }
func Orphan(c *gin.Context)            { c.JSON(200, gin.H{}) }
