export function estimateDelivery(address: { postcode?: string }): string {
  return address?.postcode ? 'two days' : 'unknown';
}
