//! `src/main.rs` beside a Cargo.toml: this crate builds something you run. That much is
//! Cargo's own signal and stays true — the archetype is not what #257 is about.
//!
//! What it is about is the sentence that used to follow. These routes are right here in
//! the source, and no reader in this tool reads them, so the map shows zero doors. The
//! bug was reporting that zero as "nothing answers a URL".

use std::env;

#[macro_use]
extern crate rocket;

mod api;

pub fn bind_address() -> String {
    env::var("ROCKET_ADDRESS").unwrap_or_default()
}

#[get("/health")]
fn health() -> &'static str {
    "ok"
}

#[launch]
fn rocket() -> _ {
    let _ = bind_address();
    rocket::build()
        .mount("/", routes![health])
        .mount("/api", api::routes())
}
