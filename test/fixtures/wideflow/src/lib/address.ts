export function validateAddress(address: { postcode?: string }): boolean {
  return Boolean(address?.postcode);
}
