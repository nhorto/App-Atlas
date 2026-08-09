package users

import "golang.org/x/crypto/bcrypt"

type UserModel struct {
	ID           uint
	Username     string
	PasswordHash string
}

// The verify: a handler that checks a password is authenticating whoever knocked,
// and cannot be demanding a session at the same time.
func (u *UserModel) CheckPassword(password string) error {
	return bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password))
}
