// Package notify tells the team when an order needs a human.
package notify

import (
	"net/http"
	"strings"
)

// OrderFailed posts a message to the team's Slack channel.
func OrderFailed(id string) error {
	body := strings.NewReader(`{"text":"order ` + id + ` failed"}`)
	_, err := http.Post("https://hooks.slack.com/services/T00000/B00000/XXXX", "application/json", body)
	return err
}
