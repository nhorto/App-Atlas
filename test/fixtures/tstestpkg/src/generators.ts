// Fixture helpers shared between specs — an e2e suite's whole "public API".
export function makeRandomImage(): Uint8Array {
  return new Uint8Array([137, 80, 78, 71]);
}

export function makeUser(name: string) {
  return { name, email: `${name}@example.com` };
}
