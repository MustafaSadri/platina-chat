import { useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icons.jsx';

export function useContextMenu() {
  const [state, setState] = useState(null);
  return {
    state,
    open: (e, items, header = null) => setState({ x: e.clientX, y: e.clientY, items, header, openedAt: Date.now() }),
    close: () => setState(null),
  };
}

const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

/** Popover menu on desktop; bottom sheet on phones (easier to hit with a thumb). */
export function ContextMenu({ state, close }) {
  const ref = useRef();
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!state || !ref.current || isPhone()) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(state.x, window.innerWidth - r.width - 8);
    const y = Math.min(state.y, window.innerHeight - r.height - 8);
    setPos({ left: Math.max(8, x), top: Math.max(8, y) });
  }, [state]);

  if (!state) return null;
  const sheet = isPhone();
  // Releasing a long-press synthesises a click on whatever is now under the finger; ignore it.
  const fresh = () => Date.now() - state.openedAt < 350;
  return (
    <>
      <div className={`menu-backdrop ${sheet ? 'dim' : ''}`} onClick={() => !fresh() && close()} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div ref={ref} className={`context-menu ${sheet ? 'sheet' : ''}`} style={sheet ? undefined : pos || { left: state.x, top: state.y, visibility: 'hidden' }}>
        {state.header && <div className="context-header" onClick={(e) => e.stopPropagation()}>{state.header(close)}</div>}
        {state.items.map((it, i) => (
          <button key={i} className={`context-item ${it.danger ? 'danger' : ''}`} onClick={() => { if (fresh()) return; close(); it.onClick(); }}>
            <Icon name={it.icon} size={20} /> {it.label}
          </button>
        ))}
      </div>
    </>
  );
}
