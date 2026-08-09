//! The binary. `src/main.rs` beside a `Cargo.toml` is Cargo's own way of saying this
//! crate builds something you run — no manifest entry and no compiler required.

use std::env;

pub fn configure() -> String {
    env::var("SERVER_BIND").unwrap_or_default()
}

fn main() {
    let _ = configure();
}
