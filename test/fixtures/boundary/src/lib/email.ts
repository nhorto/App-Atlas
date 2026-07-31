/**
 * @fileoverview Sending mail, and telling the analytics service about it.
 */
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Nobody writes the host twice: it goes in a constant, and the call interpolates it.
const FEED_BASE = 'https://updates.example.dev';

export async function latestVersion(): Promise<string> {
  const res = await fetch(`${FEED_BASE}/latest.json`);
  return (await res.json()).version;
}

export async function sendWelcome(to: string): Promise<void> {
  await resend.emails.send({ from: 'hi@example.com', to, subject: 'Welcome', html: '<p>Hi</p>' });

  await fetch('https://api.us.posthog.com/capture/', {
    method: 'POST',
    body: JSON.stringify({ event: 'welcome_sent', to }),
  });
}
