import { Controller, Delete, Post, Put } from '@nestjs/common';

import { Anyone } from './base.controllers';
import { createClient } from './supabase';

/**
 * Six doors, none of them checked, and only three of them unchecked for a reason.
 *
 * The names are the point. `handleSubmit` signs people in and says nothing about it;
 * `signIn` says everything about it and signs nobody in. A rule that read the names
 * would get both of them backwards, and getting the second one wrong takes a real open
 * door off the only list anybody reads.
 */
@Controller('session')
export class SessionController extends Anyone {
  /** Signs somebody in. Nothing in the name says so; the call does. */
  @Post()
  async handleSubmit(): Promise<unknown> {
    const supabase = createClient();
    return supabase.auth.signInWithPassword({ email: '', password: '' });
  }

  /** Ends the caller's session. Nothing can be demanded of somebody giving one up. */
  @Delete()
  async endIt(): Promise<unknown> {
    const supabase = createClient();
    return supabase.auth.signOut();
  }

  /** Named exactly like the thing this rule excuses, and it signs nobody in. */
  @Post('visit')
  async signIn(): Promise<unknown> {
    return { ok: true };
  }

  /**
   * Signs somebody up *and* writes a row of the app's own data. Being the sign-up door
   * explains the sign-up; it explains nothing about the row.
   */
  @Post('join')
  async signUpAndInvite(): Promise<unknown> {
    const supabase = createClient();
    await supabase.auth.signUp({ email: '', password: '' });
    return supabase.from('invites').insert({ email: '' });
  }

  /**
   * Changes the password of whoever is already signed in. `updateUser` needs a session,
   * so an unguarded door onto it is a real finding and has to keep saying so.
   */
  @Put('password')
  async changePassword(): Promise<unknown> {
    const supabase = createClient();
    return supabase.auth.updateUser({ password: '' });
  }

  /**
   * Signs *another* user out, which takes an administrator and a service key. A door
   * onto a privileged API is the last one in any repo that should stop being reported.
   */
  @Post('revoke')
  async forceSignOut(): Promise<unknown> {
    const supabase = createClient();
    return supabase.auth.admin.signOut('a-jwt');
  }
}
