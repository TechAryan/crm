import React, { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Contextual help. Renders a small "?" that opens a panel explaining the current screen.
 *
 * Content comes from the API rather than being hard-coded here, so wording can be corrected
 * without a frontend deploy — help text changes far more often than components do.
 *
 * Renders nothing when a screen has no help content, so adding it to a page is always safe.
 */
export function HelpButton({ topic }: { topic: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    api.get(`/v1/help/${topic}`)
      .then(d => { setData(d.found ? d : null); setLoaded(true); })
      .catch(() => { setData(null); setLoaded(true); });
  }, [open, topic, loaded]);

  return (
    <>
      <button
        className="btn btn-sm btn-ghost"
        title="What is this screen?"
        aria-label="Help"
        onClick={() => setOpen(o => !o)}
        style={{ borderRadius: '50%', width: 26, height: 26, padding: 0, fontWeight: 700 }}
      >?</button>

      {open && (
        <>
          {/* Click-away backdrop. Transparent so the page stays visible while reading. */}
          <div onClick={() => setOpen(false)}
               style={{ position: 'fixed', inset: 0, zIndex: 190 }} />
          <div className="card" style={{
            position: 'fixed', right: 20, top: 70, width: 380, maxHeight: '75vh', overflow: 'auto',
            zIndex: 200, boxShadow: '0 12px 40px rgba(0,0,0,.18)',
          }}>
            {!loaded ? (
              <div className="card-body text-muted small">Loading…</div>
            ) : !data ? (
              <div className="card-body text-muted small">No help for this screen yet.</div>
            ) : (
              <>
                <div className="card-header">
                  {data.title}
                  <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>✕</button>
                </div>
                <div className="card-body">
                  <p className="small" style={{ marginTop: 0 }}>{data.body}</p>

                  {data.steps?.length > 0 && (
                    <>
                      <div className="small text-muted" style={{ fontWeight: 600, marginTop: 14 }}>How to</div>
                      <ol className="small" style={{ paddingLeft: 18, margin: '6px 0 0' }}>
                        {data.steps.map((s: string, i: number) => (
                          <li key={i} style={{ marginBottom: 4 }}>{s}</li>
                        ))}
                      </ol>
                    </>
                  )}

                  {data.tips?.length > 0 && (
                    <>
                      <div className="small text-muted" style={{ fontWeight: 600, marginTop: 14 }}>Good to know</div>
                      <ul className="small" style={{ paddingLeft: 18, margin: '6px 0 0' }}>
                        {data.tips.map((t: string, i: number) => (
                          <li key={i} style={{ marginBottom: 4 }}>{t}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
