/**
 * The Login logo for emails: a blue rounded square and the word "Login",
 * followed by a thin divider. It sits at the top of the first card in each
 * email (welcome-email.ts, code-email.ts).
 *
 * Built from table cells, not an image, so it shows in every email app even
 * with images turned off. Some Outlook versions draw the square with sharp
 * corners.
 */
export function emailLogo(font: string): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="32" height="32" style="width:32px;height:32px;background:#2563EB;border-radius:8px;font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding-left:10px;${font}font-size:22px;line-height:32px;font-weight:700;letter-spacing:-0.02em;color:#0F172A;">Login</td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 28px 0;"><tr>
        <td height="1" style="height:1px;line-height:1px;font-size:0;background:#E2E8F0;">&nbsp;</td>
      </tr></table>`;
}
