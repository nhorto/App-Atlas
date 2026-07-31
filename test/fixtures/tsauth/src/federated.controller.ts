import { Controller, Post } from '@nestjs/common';
import { signIn } from 'next-auth/react';

import { Anyone } from './base.controllers';

/**
 * The other shape a library publishes its sign-in in: an ordinary imported function
 * rather than a method on a client somebody built. A bare `signIn` is somebody's own
 * helper far more often than it is NextAuth's, so here the import is the evidence and
 * the name is only the label on it.
 */
@Controller('federated')
export class FederatedController extends Anyone {
  @Post()
  async begin(): Promise<unknown> {
    return signIn('email', { email: '' });
  }
}
