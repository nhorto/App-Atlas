import { NextRequest, NextResponse } from 'next/server';

// The hand-rolled check: a shared-secret comparison with no auth package anywhere
// near it. Note the response shape — the 401 is in the *body*, and the wire says 200.
// It still counts (#155): the code refuses the caller, and the author locked the door.
export async function revalidate(req: NextRequest): Promise<NextResponse> {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!secret || secret !== process.env.SHOPIFY_REVALIDATION_SECRET) {
    console.error('Invalid revalidation secret.');
    return NextResponse.json({ status: 401 });
  }
  return NextResponse.json({ status: 200, revalidated: true, now: Date.now() });
}
