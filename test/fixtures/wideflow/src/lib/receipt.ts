export function formatReceipt(order: { id: string }): { id: string; sent: boolean } {
  return { id: order.id, sent: true };
}
