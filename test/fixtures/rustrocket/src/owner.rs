//! One guard, in its own file, deferring to a check declared in another — Plume's
//! `Admin`, which lives in `admin.rs` and hands to `User` in `users.rs`.
//!
//! This is the case the per-file pass cannot answer on its own, and it is why a deferral
//! this file cannot follow goes out as an `auth-alias` instead of being dropped. The
//! merge resolves it against the checker emitted from `guards.rs` — the same mechanism a
//! FastAPI `Depends` alias travels through (#136).
//!
//! Written with Rocket's own spelling rather than the macro, because the two applications
//! measured wrote it two different ways and both had to work.

use rocket::outcome::Outcome;
use rocket::request::{FromRequest, Request};

use crate::guards::SignedIn;

pub struct Owner {
    pub user: String,
}

impl<'r> FromRequest<'r> for Owner {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let signed_in = request.guard::<SignedIn>()?;
        Outcome::Success(Owner {
            user: signed_in.user,
        })
    }
}
