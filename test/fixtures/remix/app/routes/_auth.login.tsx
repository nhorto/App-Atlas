import { json, redirect } from '@remix-run/node';
import type { ActionFunctionArgs } from '@remix-run/node';
import { Form } from '@remix-run/react';

/**
 * The sign-in form. A missing email is a bad request, not a refused caller — the 400
 * here must never be read as a lock on the one page that has to stay open.
 */
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  if (!form.get('email')) return json({ error: 'Email required' }, { status: 400 });
  return redirect('/');
}

export default function Login() {
  return <Form method="post" />;
}
