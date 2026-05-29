import { useEffect, useRef, useState } from 'react';
import { useOverlayBridge } from '../hooks/useOverlayBridge';
import './OverlayControls.css';

const POSITIONS: { tag: string; label: string; title: string }[] = [
  { tag: 'tl', label: '↖', title: 'Top left' },
  { tag: 'tr', label: '↗', title: 'Top right' },
  { tag: 'c',  label: '◎', title: 'Center' },
  { tag: 'bl', label: '↙', title: 'Bottom left' },
  { tag: 'br', label: '↘', title: 'Bottom right' },
];

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

          <div className="overlay-pop-row">
            <span className="overlay-pop-label">Click-through</span>
            <button
              type="button"
              className={`overlay-toggle ${o.glance ? 'on' : ''}`}
              role="switch"
              aria-checked={o.glance}
              onClick={() => o.setGlance(!o.glance)}
              title={o.glance ? '메뉴바 아이콘에서 다시 해제할 수 있어요' : '마우스가 패널을 통과합니다'}
            >{o.glance ? 'ON' : 'OFF'}</button>
          </div>

          <div className="overlay-pop-row">
            <span className="overlay-pop-label">Position</span>
            <div className="overlay-pos-grid">
              {POSITIONS.map((p) => (
                <button
                  key={p.tag}
                  type="button"
                  className="overlay-pos-btn"
                  onClick={() => o.setPosition(p.tag)}
                  title={p.title}
                  aria-label={p.title}
                >{p.label}</button>
              ))}
            </div>
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
