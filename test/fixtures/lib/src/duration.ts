/** A length of time, kept in milliseconds so arithmetic on it is ordinary. */
export interface Duration {
  ms: number;
  label: string;
}

/** Renders a duration the way a person would say it out loud. */
export function format(duration: Duration): string {
  const seconds = Math.round(duration.ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}
