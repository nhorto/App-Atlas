export function checkStock(basket: { items: string[] }): boolean {
  return basket.items.length > 0;
}
