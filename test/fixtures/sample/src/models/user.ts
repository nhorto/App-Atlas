/**
 * @fileoverview People who can sign in to the sample app.
 */

/** Someone with an account. */
export interface User {
  id: string;
  email: string;
  displayName?: string;
  role: Role;
}

export type Role = 'admin' | 'member';

export enum Status {
  Active = 'active',
  Suspended = 'suspended',
}
