/**
 * @fileoverview Which crate means which framework.
 *
 * One table, read by two things that must never disagree: the label the app carries at
 * the top of the map, and the gate on the detectors. Crate names are exact — Cargo has
 * no scoped packages and no major-version-in-the-name convention to allow for.
 */
export const RUST_FRAMEWORKS: Record<string, string> = {
  tauri: 'Tauri',
  axum: 'Axum',
  'actix-web': 'Actix Web',
  rocket: 'Rocket',
  warp: 'warp',
  sqlx: 'sqlx',
  diesel: 'Diesel',
  'sea-orm': 'SeaORM',
  clap: 'clap',
  bevy: 'Bevy',
};

/** The label for a crate, or null when nothing in the table claims it. */
export function rustFrameworkFor(crate: string): string | null {
  return RUST_FRAMEWORKS[crate] ?? null;
}

/**
 * The web frameworks this tool can name but whose routes it never reads.
 *
 * `detectRustBoundaries` reads three things — `#[tauri::command]`, sqlx, and the
 * environment — and no route reader runs for any of these. So a crate can declare
 * Rocket, serve 305 routes across 60 files, and produce zero doors. Declining to read
 * them is the deliberate choice that file documents, and it stands.
 *
 * What does not stand is what the surfaces said next. Zero doors was reported as
 * "nothing answers a URL" about a password server whose own framework list read
 * `["Diesel", "Rocket"]` — a known absence turned into a positive finding, which is
 * the one move this project treats as unrecoverable (#257).
 *
 * Naming them here is what lets every surface stay quiet instead. Tauri is deliberately
 * absent: its commands *are* read, so a Tauri crate with no doors genuinely has none.
 * The data crates are absent for the same reason — sqlx answers no URL either way.
 */
export const RUST_ROUTES_NOT_READ = new Set(['Axum', 'Actix Web', 'Rocket', 'warp']);
