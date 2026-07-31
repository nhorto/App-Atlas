import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';

/** `_index` is the address of the folder above it, which here is the site root. */
export async function loader() {
  return json({ greeting: 'hello' });
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  return <main>{data.greeting}</main>;
}
