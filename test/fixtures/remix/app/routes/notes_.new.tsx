import { redirect } from '@remix-run/node';
import type { ActionFunctionArgs } from '@remix-run/node';
import { Form } from '@remix-run/react';

/**
 * A write with nothing in front of it: no check here, and none one hop away either.
 * The trailing underscore on `notes_` opts this page out of the `notes` layout and
 * changes nothing about the address.
 */
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const body = String(form.get('body'));
  return redirect(`/notes/${body}`);
}

export default function NewNote() {
  return <Form method="post" />;
}
