import type { User } from '../models/user';

/**
 * Builds the name shown in the interface.
 */
export function formatName(user: User): string {
  return user.displayName ?? user.email;
}

export const shout = (text: string): string => text.toUpperCase();

function unusedHelper(value: number): number {
  return value * 2;
}
