// The trap: a client whose catch block mentions 401. "The vendor said 401" is an
// upstream failure, not a decision about our caller — this function must not become
// a guard, and the products route that calls it must stay on the worry list.
export async function fetchUpstream(path: string): Promise<unknown> {
  try {
    const res = await fetch(`https://vendor.example${path}`);
    return await res.json();
  } catch (err) {
    throw new Error(`Upstream refused us: 401 UNAUTHORIZED (${String(err)})`);
  }
}
