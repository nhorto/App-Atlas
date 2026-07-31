package main

import (
	"log"
	"net/http"

	"github.com/labstack/echo/v4"
)

// registerRoutes writes every door this service opens onto the router it is handed.
//
// Echo takes the handler before its middleware — GET(path, handler, middleware...) —
// where gin and the standard library put the handler last.
func registerRoutes(e *echo.Echo) {
	e.GET("/health", health)
	e.GET("/reports/:id", showReport, RequireToken)
	e.POST("/reports", createReport, RequireToken, AuditLog)
}

// health says the service is up.
func health(c echo.Context) error {
	return c.NoContent(http.StatusOK)
}

// showReport answers with one report.
func showReport(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]string{"id": c.Param("id")})
}

// createReport files a new report.
func createReport(c echo.Context) error {
	return c.NoContent(http.StatusCreated)
}

// RequireToken turns away callers who bring no bearer token.
func RequireToken(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if c.Request().Header.Get("Authorization") == "" {
			return echo.NewHTTPError(http.StatusUnauthorized, "sign in first")
		}
		return next(c)
	}
}

// AuditLog writes a line per request and lets everybody through.
func AuditLog(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		log.Printf("%s %s", c.Request().Method, c.Request().URL.Path)
		return next(c)
	}
}
