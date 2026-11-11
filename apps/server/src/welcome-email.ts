/**
 * The welcome email, sent once when someone creates a Login account.
 *
 * The design was made in Resend's editor and approved by the KYC/design side
 * (welcome card, "what you can do next" card, closing note). It's built from
 * email-safe tables with inline styles, because email apps ignore most CSS.
 * Icons are PNGs served by the web app (apps/web/public/email/), because Gmail
 * and Outlook drop inline SVG.
 *
 * No web fonts: loading one (e.g. from Google Fonts) would make the reader's
 * email app contact a third party with their IP address every time they open
 * it. 'Geist' is named first only for people who have it installed; everyone
 * else gets Arial.
 *
 * Nothing about the person goes into it: Login doesn't collect names, so it
 * greets everyone with "Hi there,". The only input is the app's own address,
 * from the server's config.
 */

import { emailLogo } from './email-logo.ts';

export interface WelcomeEmail {
  subject: string;
  /** Plain-text copy for email apps that can't show the design. */
  text: string;
  html: string;
}

/** @param appUrl The app's own origin, e.g. https://demo.withlogin.com (config.origins[0]). */
export function welcomeEmail(appUrl: string): WelcomeEmail {
  const app = appUrl.replace(/\/+$/, '');
  const icon = (name: string) => `${app}/email/icon-${name}.png`;
  const font = `font-family:'Geist',Arial,Helvetica,sans-serif;`;

  const card = 'max-width:560px;margin:24px auto;border:1px solid #C7D7FE;border-radius:16px;border-collapse:separate;background:#FFFFFF;';

  const tile = (name: string, size: number) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
              <td width="48" height="48" align="center" valign="middle" style="width:48px;min-width:48px;height:48px;padding:0;border-radius:12px;background:#EFF4FF;line-height:0;font-size:0;">
                <img src="${icon(name)}" width="${size}" height="${size}" alt="" style="display:block;width:${size}px;height:${size}px;border:0;outline:none;">
              </td>
            </tr></table>`;

  const step = (iconName: string, iconSize: number, title: string, text: string) => `
        <tr>
          <td width="68" valign="top" style="width:68px;min-width:68px;padding:0;">${tile(iconName, iconSize)}
          </td>
          <td valign="top" style="padding-top:2px;${font}">
            <a href="${app}" style="display:block;${font}font-size:17px;line-height:24px;font-weight:600;color:#0F172A;text-decoration:none;">${title}</a>
            <p style="margin:4px 0 0 0;${font}font-size:15px;line-height:22px;color:#475569;">${text}</p>
          </td>
        </tr>`;

  const gap = `
        <tr><td colspan="2" height="28" style="height:28px;line-height:28px;font-size:0;">&nbsp;</td></tr>`;

  const bullet = (text: string, last: boolean) => `
              <tr>
                <td width="18" valign="top" style="${last ? '' : 'padding:0 0 8px 0;'}font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:24px;color:#2563EB;">&bull;</td>
                <td valign="top" style="${last ? '' : 'padding:0 0 8px 0;'}${font}font-size:15px;line-height:24px;color:#0F172A;">${text}</td>
              </tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Welcome to Login</title>
</head>
<body style="margin:0;padding:16px;background:#FFFFFF;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${card}">
  <tr>
    <td style="padding:28px 28px 32px;${font}">${emailLogo(font)}
      <h1 style="margin:0 0 20px 0;${font}font-size:32px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:#0F172A;">Welcome to Login.</h1>
      <p style="margin:0 0 16px 0;${font}font-size:16px;line-height:1.6;color:#0F172A;">Hi there,</p>
      <p style="margin:0 0 24px 0;${font}font-size:16px;line-height:1.6;color:#475569;">Your account is ready, and your passkey is your key. Only your passkey can open your wallet. Not even Login can.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EFF4FF;border-left:4px solid #2563EB;border-radius:10px;border-collapse:separate;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 4px 0;${font}font-size:16px;font-weight:600;line-height:1.4;color:#2563EB;">Before anything else</p>
            <p style="margin:0;${font}font-size:15px;line-height:1.6;color:#0F172A;">Add a backup passkey on another device, like your phone. If you lose your only device, nobody can recover your wallet for you.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${card}">
  <tr>
    <td style="padding:36px 32px;${font}">
      <h2 style="margin:0 0 28px 0;${font}font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:#0F172A;">Here’s what you can do next on Login.</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${step('plus', 24, 'Add test money', 'It shows up as a private USDT balance.')}${gap}${step('send', 20, 'Send privately', 'Send some to someone. Amounts and who paid whom stay private.')}${gap}${step('fingerprint', 20, 'Sign in with one click', 'The app gets a unique ID for you and nothing else unless you approve it.')}
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
        <tr>
          <td style="border-radius:12px;background:#2563EB;">
            <a href="${app}" style="display:inline-block;padding:16px 28px;${font}font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:12px;">Add test money &#8594;&#xFE0E;</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${card}">
  <tr>
    <td style="padding:28px;${font}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EFF4FF;border-radius:12px;border-collapse:separate;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 10px 0;${font}font-size:16px;font-weight:600;line-height:1.4;color:#2563EB;">One important note:</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bullet('Verification is optional. If you choose to do it, you only do it once.', false)}${bullet('Login will never ask for your password, recovery phrase or ID by email.', true)}
            </table>
          </td>
        </tr>
      </table>
      <p style="margin:22px 0 0 0;${font}font-size:16px;line-height:1.5;color:#0F172A;">High fives,<br><span style="font-weight:600;color:#2563EB;">The Login team at Dexlabs</span></p>
    </td>
  </tr>
</table>

</body>
</html>
`;

  const text = `Welcome to Login.

Hi there,

Your account is ready, and your passkey is your key. Only your passkey can open your wallet. Not even Login can.

Before anything else: add a backup passkey on another device, like your phone. If you lose your only device, nobody can recover your wallet for you.

Here's what you can do next on Login:
- Add test money. It shows up as a private USDT balance.
- Send privately. Send some to someone. Amounts and who paid whom stay private.
- Sign in with one click. The app gets a unique ID for you and nothing else unless you approve it.

Get started: ${app}

One important note:
- Verification is optional. If you choose to do it, you only do it once.
- Login will never ask for your password, recovery phrase or ID by email.

High fives,
The Login team at Dexlabs
`;

  return { subject: 'Welcome to Login', text, html };
}
