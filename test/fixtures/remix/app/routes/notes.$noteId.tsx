import { json } from '@remix-run/node';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import { requireUserId } from '~/session.server';

/** The filename carries the whole address: `notes.$noteId` answers at `/notes/:noteId`. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  return json({ userId, noteId: params.noteId });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUserId(request);
  return json({ ok: true });
}

export default function NoteDetail() {
  const data = useLoaderData<typeof loader>();
  return <main>{data.noteId}</main>;
}
