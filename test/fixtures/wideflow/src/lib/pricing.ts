export function priceBasket(basket: { items: string[] }): number {
  return basket.items.length * 100;
}
