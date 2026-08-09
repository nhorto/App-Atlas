import { NextRequest, NextResponse } from 'next/server';

// The check written inline in the handler, which is how most hand-rolled Next.js auth
// is spelled. The framework requires the function be called POST, so naming the guard
// after it told a reader this route was "protected by POST" (#190).
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-api-key') !== process.env.RENAME_KEY) {
    return NextResponse.json({ error: 'no' }, { status: 401 });
  }
  return NextResponse.json({ renamed: true });
}
