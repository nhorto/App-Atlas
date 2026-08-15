// The application. No route reader runs for Actix Web, so none of these becomes a door —
// which is the deliberate choice `RUST_ROUTES_NOT_READ` documents, and it stands. What
// must not happen is the rest of the map describing this repository as though these
// routes were weighed and found fine (#271).
use actix_web::{web, App, HttpResponse, HttpServer, Responder};

async fn list_documents() -> impl Responder {
    HttpResponse::Ok().json(Vec::<String>::new())
}

async fn delete_document(path: web::Path<String>) -> impl Responder {
    HttpResponse::Ok().body(format!("deleted {}", path))
}

async fn admin_reset() -> impl Responder {
    HttpResponse::Ok().body("reset")
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/documents", web::get().to(list_documents))
            .route("/documents/{id}", web::delete().to(delete_document))
            .route("/admin/reset", web::post().to(admin_reset))
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
