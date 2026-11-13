/** Lists per-app disclosures, including explicitly approved level sharing. */
import { useEffect, useState } from 'react';
import { api } from './api.ts';

type Apps = { apps: { name: string; sharesVerificationLevel?: boolean }[]; verifiedHuman: boolean; sandbox: boolean };

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

  // Gold's Figma (Settings, 12 Nov): a heading and one row per app; the row says what that app sees.
  return (
    <section className="set-section" aria-labelledby="apps-h">
      <h2 id="apps-h">Apps you’ve signed into</h2>
      {data && data.apps.length > 0 ? (
        <ul className="set-group" data-testid="connected-apps">
          {data.apps.map((a, i) => (
            <li key={i} className="set-row">
              <span>{a.name}</span>
              <span className="set-value muted">
                Sees an ID only it gets{data.verifiedHuman ? <>, and that you’re a verified human{data.sandbox ? ' (test mode)' : ''}</> : null}{a.sharesVerificationLevel ? <>, plus your verification level when available</> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="set-group">
          <div className="set-row">
            <span>{failed ? 'Couldn’t load this list. Reload the page to try again.' : data ? 'None yet.' : 'Loading…'}</span>
          </div>
        </div>
      )}
    </section>
  );
}
