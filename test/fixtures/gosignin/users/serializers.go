package users

import "github.com/example/gosignin/common"

type UserSerializer struct {
	User UserModel
}

// The middle hop: the handler calls this, this calls the mint.
func (s *UserSerializer) Response() map[string]any {
	return map[string]any{
		"username": s.User.Username,
		"token":    common.GenToken(s.User.ID),
	}
}
