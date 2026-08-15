//! An Axum service, which App Atlas names and whose routes it does not read.
//!
//! Rocket left `RUST_ROUTES_NOT_READ` when #268 taught the tool to read its routes, so
//! this crate is what keeps the caveat under test. The route below is real and answers a
//! URL; no reader here sees it, and the whole point of #257 is that the map must say so
//! rather than imply nothing answers anything.

use axum::{routing::get, Router};

async fn health() -> &'static str {
    "ok"
}

async fn whoami() -> &'static str {
    "nobody"
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .route("/whoami", get(whoami));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
