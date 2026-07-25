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

/** Whoever is signed in at the moment. */
export class Session {
  /** The person, when there is one — an annotation, so it links to User. */
  signedIn: User | null = null;
  /** An initializer rather than a type, so it must not link to anything. */
  label = defaultLabel();
}

function defaultLabel(): string {
  return 'nobody';
}
