//! The routes vaultwarden has 305 of, in miniature. Attribute macros on functions —
//! the same shape `#[tauri::command]` is already read as a door, which is why issue
//! #257 filed reading them as merely *larger*, not impossible.
//!
//! Every guard in `guards.rs` is used here at least once, so the doors are what say
//! whether the rule that decides them is right.

use rocket::serde::json::Json;
use rocket::Route;

use crate::guards::{AdminOnly, Origin, Pool, Session, SignedIn, SignupOpen};
use crate::owner::Owner;

/// A type in a handler's signature that is not a request guard at all — no
/// `FromRequest` implementation anywhere. It must not become a check by sitting where
/// one would sit.
pub struct Authenticated;

#[get("/accounts/profile")]
pub fn profile(_session: Session) -> Json<&'static str> {
    Json("profile")
}

#[get("/accounts/revision-date")]
pub fn revision_date(_signed_in: SignedIn) -> Json<i64> {
    Json(0)
}

#[delete("/admin/users/<user_id>")]
pub fn delete_user(user_id: &str, _admin: AdminOnly) -> Json<&str> {
    Json(user_id)
}

#[get("/blogs/<name>/settings")]
pub fn blog_settings(name: &str, _owner: Owner) -> Json<&str> {
    Json(name)
}

// Public by design, all four of them.

#[get("/users/<user_id>/public-key")]
pub fn public_key(user_id: &str) -> Json<&str> {
    Json(user_id)
}

#[post("/accounts/register", data = "<body>")]
pub fn register(body: Json<&str>, _open: SignupOpen) -> Json<&str> {
    body
}

#[get("/status")]
pub fn status(_origin: Origin, _pool: Pool) -> Json<&'static str> {
    Json("ok")
}

#[get("/legacy")]
pub fn legacy(_user: Authenticated) -> Json<&'static str> {
    Json("legacy")
}

pub fn routes() -> Vec<Route> {
    routes![
        profile,
        revision_date,
        delete_user,
        blog_settings,
        public_key,
        register,
        status,
        legacy
    ]
}
