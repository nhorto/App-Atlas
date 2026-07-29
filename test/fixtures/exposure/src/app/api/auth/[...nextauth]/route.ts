import NextAuth from 'next-auth';

/**
 * The door people sign in through. It cannot require a session to hand one out, so
 * "no auth check" is the only thing it could possibly say.
 */
const handler = NextAuth({ providers: [] });

export { handler as GET, handler as POST };
