import { describe, expect, it } from 'vitest';
import { codeEmail } from './code-email.ts';
import { welcomeEmail } from './welcome-email.ts';

describe('logo and sign-off in both emails', () => {
  const emails = { welcome: welcomeEmail('https://demo.withlogin.com'), code: codeEmail('482913') };

  for (const [name, e] of Object.entries(emails)) {
    it(`${name}: the logo and its divider come first, inside the first card, before the heading`, () => {
      const logo = e.html.indexOf('>Login</td>');
      const divider = e.html.indexOf('background:#E2E8F0;');
      const firstCard = e.html.indexOf('border:1px solid #C7D7FE');
      const heading = e.html.indexOf('<h1');
      expect(firstCard).toBeGreaterThan(-1);
      expect(firstCard).toBeLessThan(logo);
      expect(logo).toBeLessThan(divider);
      expect(divider).toBeLessThan(heading);
      expect(e.html.match(/>Login<\/td>/g)).toHaveLength(1);
      expect(e.html).not.toMatch(/<img[^>]*logo/i); // built from cells, not an image
    });

    it(`${name}: signs off as the Login team at Dexlabs`, () => {
      expect(e.html).toContain('High fives,<br><span style="font-weight:600;color:#2563EB;">The Login team at Dexlabs</span>');
      expect(e.text).toContain('High fives,\nThe Login team at Dexlabs');
      expect(e.html + e.text).not.toContain('Team Login.');
    });
  }
});
