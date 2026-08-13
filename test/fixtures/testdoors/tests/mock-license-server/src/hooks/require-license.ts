import type { FastifyReply, FastifyRequest } from 'fastify';

/** The mock server's own lock. Real, and still not the application's. */
export async function requireLicense(request: FastifyRequest, reply: FastifyReply) {
  if (!request.headers.authorization) {
    reply.code(401);
    throw new Error('unauthorized');
  }
}
