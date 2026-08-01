/** The one place in the console that actually goes out to the network. */
export async function fetchFeedVersion(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = await response.json();
  return body.version ?? null;
}
