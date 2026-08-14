//! The routes vaultwarden has 305 of, in miniature. Attribute macros on functions —
//! the same shape `#[tauri::command]` is already read as a door, which is why issue
//! #257 files reading them as merely *larger*, not impossible.
//!
//! Two of them are unauthenticated by design and one takes a guard, so a future reader
//! has something to be right about beyond the count.

use rocket::serde::json::Json;
use rocket::Route;

pub struct Authenticated;

#[get("/accounts/profile")]
pub fn profile(_user: Authenticated) -> Json<&'static str> {
    Json("profile")
}

#[get("/accounts/revision-date")]
pub fn revision_date(_user: Authenticated) -> Json<i64> {
    Json(0)
}

#[get("/users/<user_id>/public-key")]
pub fn public_key(user_id: &str) -> Json<&str> {
    Json(user_id)
}

#[post("/accounts/register", data = "<body>")]
pub fn register(body: Json<&str>) -> Json<&str> {
    body
}

pub fn routes() -> Vec<Route> {
    routes![profile, revision_date, public_key, register]
}
