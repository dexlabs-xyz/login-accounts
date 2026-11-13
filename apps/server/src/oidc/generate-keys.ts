/** Run locally by the deployment owner. Never run this in a shared/logged build. */
import { writeFileSync } from 'node:fs';
import { generateOidcKeys } from './config.ts';
const output = process.argv[2];
if (!output) {
  console.error(
    'Usage: npm run oidc:generate-keys -- /private/path/oidc-secrets.json (new file; never commit or share it)',
  );
  process.exitCode = 1;
} else {
  const material = generateOidcKeys();
  const values =
    JSON.stringify({ OIDC_JWKS: material.jwks, OIDC_COOKIE_KEYS: material.cookieKeys }, null, 2) +
    '\n';
  // Fail rather than overwrite keys; mode 0600 on POSIX. Windows owners should restrict file ACLs.
  writeFileSync(output, values, { flag: 'wx', mode: 0o600 });
  console.log(
    'OIDC secrets saved to the requested private file. Paste values into host settings; never paste them in chat.',
  );
}
