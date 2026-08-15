/**
 * @fileoverview Which Go module means which framework.
 *
 * One table, read by two things that must never disagree: the label the app carries at
 * the top of the map, and the gate on the detectors. A repo whose header says "chi" and
 * whose boundary view is empty is a repo where these two tables drifted apart.
 *
 * Matched as a prefix because Go puts major versions in the import path. chi is
 * `github.com/go-chi/chi/v5` today and will be `/v6` before long, and a table that has to
 * be edited every time somebody ships a major version is a table that will be wrong.
 */
export const GO_FRAMEWORKS = {
    'github.com/go-chi/chi': 'chi',
    'github.com/gin-gonic/gin': 'Gin',
    'github.com/labstack/echo': 'Echo',
    'github.com/gorilla/mux': 'gorilla/mux',
    'github.com/gofiber/fiber': 'Fiber',
    'google.golang.org/grpc': 'gRPC',
    'gorm.io/gorm': 'GORM',
    'github.com/jmoiron/sqlx': 'sqlx',
    'entgo.io/ent': 'Ent',
    'github.com/spf13/cobra': 'Cobra',
};
/** The label for a module path, or null when nothing in the table claims it. */
export function goFrameworkFor(module) {
    for (const [prefix, label] of Object.entries(GO_FRAMEWORKS)) {
        if (module === prefix || module.startsWith(`${prefix}/`))
            return label;
    }
    return null;
}
//# sourceMappingURL=frameworks.js.map