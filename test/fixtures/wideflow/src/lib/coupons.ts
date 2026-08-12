export function applyCoupon(total: number, code?: string): number {
  return code ? total - 10 : total;
}
