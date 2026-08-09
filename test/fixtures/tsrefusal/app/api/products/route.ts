import { NextResponse } from 'next/server';
import { fetchUpstream } from '../../../lib/upstream';

export async function GET(): Promise<NextResponse> {
  const products = await fetchUpstream('/products');
  return NextResponse.json({ products });
}
