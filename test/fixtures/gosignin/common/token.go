// The mint. Two hops from the route that needs it, which is the distance the
// realworld app keeps (#147): UsersLogin → Response → GenToken.
package common

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var secret = []byte("fixture")

func GenToken(id uint) string {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"id":  id,
		"exp": time.Now().Add(time.Hour * 72).Unix(),
	})
	signed, _ := token.SignedString(secret)
	return signed
}
