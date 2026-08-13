import type { Request, Response } from 'express';

/** No token, no verification, anonymous accountability — and no refusal. */
export async function accountabilityForToken(token?: string | null): Promise<unknown> {
  if (token) {
    return verify(token);
  }
  return { user: null, admin: false };
}

export async function parse(_req: Request, _res: Response): Promise<boolean> {
  return true;
}

declare function verify(token: string): Promise<unknown>;
