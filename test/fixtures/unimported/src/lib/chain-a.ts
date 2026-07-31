/**
 * @fileoverview The head of an abandoned pair: nothing imports this, and this imports
 * `chain-b`. Only the head belongs on the list — the tail really is imported.
 */
import { stepTwo } from './chain-b';

export function stepOne(input: string): string {
  return stepTwo(input);
}
