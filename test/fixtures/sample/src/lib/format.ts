import type { User } from '../models/user';

/**
 * Builds the name shown in the interface.
 */
export function formatName(user: User): string {
  return user.displayName ?? user.email;
}

export const shout = (text: string): string => text.toUpperCase();

/** The service-object pattern: functions living as properties of an exported const. */
export const userStore = {
  /** Reads one user by id. */
  async load(id: string): Promise<User | null> {
    return id === '1' ? { id, email: 'a@b.c', role: 'member' } : null;
  },
  save: async (user: User): Promise<void> => {
    void user;
  },
};

function unusedHelper(value: number): number {
  return value * 2;
}
