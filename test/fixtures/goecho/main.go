// Command reports serves the reporting API.
package main

import (
	"github.com/labstack/echo/v4"
)

func main() {
	e := echo.New()
	registerRoutes(e)
	e.Logger.Fatal(e.Start(":8080"))
}
