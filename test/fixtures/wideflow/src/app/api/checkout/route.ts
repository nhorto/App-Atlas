/**
 * @fileoverview A door with a real amount of code behind it.
 *
 * Every other fixture in this directory has a handler that calls one or two things, so a
 * walkthrough of it has nothing to leave out and the honesty guard that counts what a
 * walk went past never fires. Real screens reach thirty or forty pieces of code. This is
 * the smallest thing shaped like that: one route, a wide first hop, and exactly one line
 * through it that ends at the database.
 */
import { checkStock } from '../../../lib/stock';
import { priceBasket } from '../../../lib/pricing';
import { applyCoupon } from '../../../lib/coupons';
import { validateAddress } from '../../../lib/address';
import { estimateDelivery } from '../../../lib/delivery';
import { recordOrder } from '../../../lib/orders';
import { formatReceipt } from '../../../lib/receipt';
import { auditTrail } from '../../../lib/audit';

export async function POST(request: Request) {
  const basket = await request.json();

  checkStock(basket);
  validateAddress(basket.address);
  estimateDelivery(basket.address);
  auditTrail('checkout', basket);

  const priced = priceBasket(basket);
  const total = applyCoupon(priced, basket.coupon);

  const order = await recordOrder(basket, total);
  return Response.json(formatReceipt(order));
}
