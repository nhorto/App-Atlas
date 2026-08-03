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
