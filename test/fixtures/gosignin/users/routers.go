package users

import "github.com/gin-gonic/gin"

func Routes(r *gin.RouterGroup) {
	r.POST("/users", UsersRegister)
	r.POST("/users/login", UsersLogin)
	r.GET("/ping", Ping)
}

// Signs you up and hands you a token in the same breath — no password *check*, so the
// only path from here to the credential is the two-hop one through the serializer.
// This is the route that proves the walk goes two hops, not one.
func UsersRegister(c *gin.Context) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(400, gin.H{"error": "bad request"})
		return
	}
	user := UserModel{ID: 2, Username: body.Username}
	serializer := UserSerializer{User: user}
	c.JSON(201, gin.H{"user": serializer.Response()})
}

// The route #147 is about. It answers a wrong password with a 401 — which the
// rejection reading takes for a guard — and it is the one route that cannot require a
// caller to be signed in, because it is where being signed in starts.
func UsersLogin(c *gin.Context) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(400, gin.H{"error": "bad request"})
		return
	}
	user := findUser(body.Username)
	if user == nil || user.CheckPassword(body.Password) != nil {
		c.JSON(401, gin.H{"error": "invalid credentials"})
		return
	}
	serializer := UserSerializer{User: *user}
	c.JSON(200, gin.H{"user": serializer.Response()})
}

// A plain unguarded route beside the login, so an over-broad rule that excuses
// whatever sits near a mint has something to get wrong.
func Ping(c *gin.Context) {
	c.JSON(200, gin.H{"pong": true})
}

func findUser(username string) *UserModel {
	if username == "" {
		return nil
	}
	return &UserModel{ID: 1, Username: username, PasswordHash: "$2a$10$fixture"}
}
