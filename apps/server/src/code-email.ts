/**
 * The sign-in code email (passkeys D2), in the same design as the welcome
 * email (welcome-email.ts): one card, the code in Geist Mono in a light blue
 * panel. No links, buttons or images, so it loads fast and doesn't look like
 * phishing. The subject keeps the code, so people can read it from their inbox.
 * No web fonts, for the same privacy reason as welcome-email.ts: the code
 * falls back to the reader's own monospace font.
 */

import { emailLogo } from './email-logo.ts';

export interface CodeEmail {
  subject: string;
  /** Plain-text copy for email apps that can't show the design. */
  text: string;
  html: string;
}

/** @param code The 6-digit code. Only digits are accepted, so nothing else can reach the HTML. */
export function codeEmail(code: string): CodeEmail {
  if (!/^\d{6}$/.test(code)) throw new Error('A sign-in code is 6 digits.');
  const font = `font-family:'Geist',Arial,Helvetica,sans-serif;`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Your Login code</title>
</head>
<body style="margin:0;padding:16px;background:#FFFFFF;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:24px auto;border:1px solid #C7D7FE;border-radius:16px;border-collapse:separate;background:#FFFFFF;">
  <tr>
    <td style="padding:28px 28px 32px;${font}">${emailLogo(font)}
      <h1 style="margin:0 0 12px 0;${font}font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:#0F172A;">Your Login code</h1>
      <p style="margin:0 0 20px 0;${font}font-size:16px;line-height:1.6;color:#475569;">Enter this code to continue. It expires in 10 minutes.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EFF4FF;border-radius:12px;border-collapse:separate;">
        <tr>
          <td align="center" style="padding:22px 20px;font-family:'Geist Mono',ui-monospace,Menlo,Consolas,monospace;font-size:36px;line-height:1;font-weight:600;letter-spacing:0.18em;color:#2563EB;">${code}</td>
        </tr>
      </table>
      <p style="margin:20px 0 0 0;${font}font-size:14px;line-height:1.6;color:#475569;">If you didn’t ask for it, ignore this email. Login will never ask you for this code by phone, chat or email.</p>
      <p style="margin:22px 0 0 0;${font}font-size:16px;line-height:1.5;color:#0F172A;">High fives,<br><span style="font-weight:600;color:#2563EB;">The Login team at Dexlabs</span></p>
    </td>
  </tr>
</table>

</body>
</html>
`;

  const text = `Your Login code is ${code}. It expires in 10 minutes.

If you didn't ask for it, ignore this email. Login will never ask you for this code by phone, chat or email.

High fives,
The Login team at Dexlabs
`;

  return { subject: `${code} is your Login code`, text, html };
}
