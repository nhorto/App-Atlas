//! Rocket's checks are request guards — a handler asks for a type, and the type decides
//! whether the caller gets in. Every shape here was taken from one of the two Rocket
//! applications this rule was measured against, because the two that must NOT read as
//! checks are what killed the first two designs (#257).
//!
//! Nothing here is named like a check on purpose. vaultwarden's strongest lock is called
//! `Headers`.

use rocket::http::Status;
use rocket::outcome::Outcome;
use rocket::request::{FromRequest, Request};

pub struct Session {
    pub user: String,
}

/// A check. vaultwarden's `Headers`: the credential is a bearer token in a header.
///
/// Note it refuses through a project macro rather than writing a status code, which is
/// what vaultwarden does and what defeated the "count the refusals" design — the 401
/// lives in `err_handler!`, whose body is not in the IR at all.
impl<'r> FromRequest<'r> for Session {
    type Error = &'static str;

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let Some(header) = request.headers().get_one("Authorization") else {
            refuse!("No access token provided")
        };
        let Some(token) = header.rsplit("Bearer ").next() else {
            refuse!("Malformed authorization header")
        };
        Outcome::Success(Session {
            user: token.to_owned(),
        })
    }
}

pub struct SignedIn {
    pub user: String,
}

/// A check. Plume's `User`: the credential is a signed cookie, and the refusal is
/// `Outcome::Forward` — no status code anywhere, because in Rocket a guard that forwards
/// means "this route does not match", and the request falls through to the `rank = 2`
/// route below.
impl<'r> FromRequest<'r> for SignedIn {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        match request.cookies().get_private(AUTH_COOKIE) {
            Some(cookie) => Outcome::Success(SignedIn {
                user: cookie.value().to_owned(),
            }),
            None => Outcome::Forward(()),
        }
    }
}

pub struct AdminOnly {
    pub user: String,
}

/// A check, and it reads no credential of its own — it defers, through the macro
/// vaultwarden defers with. `AdminHeaders` → `OrgHeaders` → `Headers` is three deep in
/// one file there, so the chain is followed to a fixed point rather than one hop.
impl<'r> FromRequest<'r> for AdminOnly {
    type Error = &'static str;

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let session = try_outcome!(Session::from_request(request).await);
        if session.user.starts_with("admin-") {
            Outcome::Success(AdminOnly { user: session.user })
        } else {
            refuse!("You need to be an admin to call this endpoint")
        }
    }
}

pub struct Origin {
    pub host: String,
}

/// NOT a check, and the trap that a "reads a header" rule would fall into. vaultwarden's
/// `Host` reads `Referer`, `X-Forwarded-Proto` and `X-Forwarded-Host` and authenticates
/// nobody; claiming it would put a lock on every door in the crate.
impl<'r> FromRequest<'r> for Origin {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let host = match request.headers().get_one("Referer") {
            Some(referer) => referer.to_owned(),
            None => match request.headers().get_one("X-Forwarded-Host") {
                Some(forwarded) => forwarded.to_owned(),
                None => String::from("localhost"),
            },
        };
        Outcome::Success(Origin { host })
    }
}

pub struct SignupOpen;

/// NOT a check, and the trap that an `Outcome::Forward` rule would fall into. This is
/// Plume's `Password` guard: it forwards exactly as the real checks do, and it reads
/// nothing from the request at all — it asks whether a feature is switched on. #203
/// settled that a refusal whose condition never reads the request is not a check on the
/// caller, and this is that rule in a second language.
impl<'r> FromRequest<'r> for SignupOpen {
    type Error = ();

    async fn from_request(_request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        match CONFIG.signups_allowed {
            true => Outcome::Success(SignupOpen),
            false => Outcome::Forward(()),
        }
    }
}

pub struct Pool;

/// NOT a check either, and it is the one that *does* write a status code. Plume's
/// `DbConn` refuses with `ServiceUnavailable` when the pool is exhausted — an
/// infrastructure failure, not a decision about who is calling.
impl<'r> FromRequest<'r> for Pool {
    type Error = ();

    async fn from_request(_request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        match POOL.get() {
            Ok(_) => Outcome::Success(Pool),
            Err(_) => Outcome::Failure((Status::ServiceUnavailable, ())),
        }
    }
}
