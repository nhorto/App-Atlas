import { db } from './db';

/** The one hop that ends somewhere outside the app, which is what the walk should find. */
export async function recordOrder(basket: { items: string[] }, total: number) {
  return db.order.create({ data: { total, lines: basket.items.length } });
}
