"""The prefix nobody writes down twice.

The most-used FastAPI template in existence keeps its API prefix on a settings class
and mounts with `prefix=settings.API_PREFIX`. Nothing in any route file mentions
`/api/v2`, so a reader given `/{id}` has been handed an address that does not answer.
"""


class Settings:
    API_PREFIX: str = "/api/v2"
    # A second path-shaped constant, so the lookup has to pick by name rather than by
    # being the only candidate.
    STATIC_DIR: str = "/var/www"


settings = Settings()
