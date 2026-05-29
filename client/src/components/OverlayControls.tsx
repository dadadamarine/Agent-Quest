import { useEffect, useRef, useState } from 'react';
import { useOverlayBridge } from '../hooks/useOverlayBridge';
import './OverlayControls.css';

export function OverlayControls() {
  const o = useOverlayBridge();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Only meaningful inside the native overlay app.
  if (!o.available) return null;

  return (
    <div className="overlay-controls" ref={rootRef}>
      <button
        type="button"
        className={`topbar-effect-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Overlay settings"
        title="Overlay settings"
      >{'\u{1F39B}\u{FE0F}'}</button>

      {open && (
        <div className="overlay-pop" role="dialog" aria-label="Overlay settings">
          <div className="overlay-pop-row">
            <span className="overlay-pop-label">Opacity</span>
            <input
              type="range" min={0.2} max={1} step={0.05}
              value={o.opacity}
              onChange={(e) => o.setOpacity(Number(e.target.value))}
              aria-label="Overlay opacity"
            />
            <span className="overlay-pop-val">{Math.round(o.opacity * 100)}%</span>
          </div>

          <div className="overlay-pop-actions">
            <button type="button" onClick={o.reload} title="Reload dashboard">Reload</button>
            <button type="button" onClick={o.openBrowser} title="Open in browser">Browser</button>
            <button type="button" onClick={o.restartServer} title="Restart server">Restart</button>
            <button type="button" onClick={o.hide} title="Hide overlay">Hide</button>
          </div>
        </div>
      )}
    </div>
  );
}
