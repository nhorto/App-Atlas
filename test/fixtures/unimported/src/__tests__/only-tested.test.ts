/** @fileoverview Exercises the helper, and is the only thing that does. */
import { helper } from '../lib/only-tested';

export function checkHelper(): boolean {
  return helper(2) === 4;
}
