/**
 * @fileoverview Sending mail, and telling the analytics service about it.
 */
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendWelcome(to: string): Promise<void> {
  await resend.emails.send({ from: 'hi@example.com', to, subject: 'Welcome', html: '<p>Hi</p>' });

  await fetch('https://api.us.posthog.com/capture/', {
    method: 'POST',
    body: JSON.stringify({ event: 'welcome_sent', to }),
  });
}
