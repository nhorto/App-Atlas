// vercel/commerce's own shape (#155): the handler is one line, and the whole of the
// check lives a file away.
import { NextRequest, NextResponse } from 'next/server';
import { revalidate } from '../../../lib/shopify';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return revalidate(req);
}
