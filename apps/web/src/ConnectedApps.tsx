/**
 * "Apps you've signed in to": each app that got a Login ID for this account,
 * and exactly what it can see. Every app sees the same two things at most:
 * an ID that only that app gets, and "verified human" if the user passed.
 * Never the email, name, wallet or identity documents (decision, 9 Nov 2026).
 */
import { useEffect, useState } from 'react';
import { api } from './api.ts';

type Apps = { apps: { name: string }[]; verifiedHuman: boolean; sandbox: boolean };

/** `refreshKey` changes when the verification result changes, so the list stays in step. */
export function ConnectedApps({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<Apps | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api<Apps>('GET', '/api/oidc/apps')
      .then((d) => live && (setData(d), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  return (
    <section className="card" aria-labelledby="apps-h">
      <h2 id="apps-h">Apps you’ve signed in to</h2>
      {failed && <p className="muted">Couldn’t load this list. Reload the page to try again.</p>}
      {!failed && !data && <p className="muted">Loading…</p>}
      {data && data.apps.length === 0 && (
        <p className="muted">None yet. When you use “Continue with Login” on another app, it shows up here with what it can see.</p>
      )}
      {data && data.apps.length > 0 && (
        <>
          <ul className="connected-apps" data-testid="connected-apps">
            {data.apps.map((a, i) => (
              <li key={i}>
                <strong>{a.name}</strong> sees: an ID that only this app gets
                {data.verifiedHuman ? <>, and that you’re a verified human{data.sandbox ? ' (test mode)' : ''}</> : null}.
              </li>
            ))}
          </ul>
          <p className="muted small">No app sees your email, name, wallet or identity documents.</p>
        </>
      )}
    </section>
  );
}
