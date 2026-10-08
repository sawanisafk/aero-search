/**
 * AeroWindow — the frosted-glass window chrome (Win7 style).
 * Draggable by the title bar, focusable, minimizable, maximizable,
 * closable. Position/size live in App state (App owns the window manager).
 */

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CloseGlyph, MaxGlyph, MinGlyph } from '../components/Icons';

export interface AeroWindowProps {
  readonly title: string;
  readonly icon: ReactNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onToggleMaximize: () => void;
  readonly onMove: (x: number, y: number) => void;
  readonly children: ReactNode;
}

export function AeroWindow(props: AeroWindowProps): React.JSX.Element {
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (props.maximized) return;
    props.onFocus();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - props.x, dy: e.clientY - props.y };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    const maxX = Math.max(0, window.innerWidth - 140);
    const maxY = Math.max(0, window.innerHeight - 90);
    const x = Math.min(maxX, Math.max(-(props.w - 140), e.clientX - drag.current.dx));
    const y = Math.min(maxY, Math.max(0, e.clientY - drag.current.dy));
    props.onMove(x, y);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current !== null) {
      drag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const cls = [
    'aero-window',
    props.focused ? 'focused' : '',
    props.maximized ? 'maximized' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style = props.maximized
    ? { left: 0, top: 0, width: '100vw', height: 'calc(100vh - 50px)', zIndex: props.z }
    : { left: props.x, top: props.y, width: props.w, height: props.h, zIndex: props.z };

  return (
    <section className={cls} style={style} onPointerDownCapture={props.onFocus} aria-label={props.title}>
      <header
        className="aero-titlebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={props.onToggleMaximize}
      >
        <span className="icon">{props.icon}</span>
        <span className="title">{props.title}</span>
        <div className="window-controls" onPointerDown={(e) => e.stopPropagation()}>
          <button className="win-btn" onClick={props.onMinimize} aria-label={`Minimize ${props.title}`}>
            <MinGlyph />
          </button>
          <button
            className="win-btn"
            onClick={props.onToggleMaximize}
            aria-label={`Maximize ${props.title}`}
          >
            <MaxGlyph />
          </button>
          <button className="win-btn close" onClick={props.onClose} aria-label={`Close ${props.title}`}>
            <CloseGlyph />
          </button>
        </div>
      </header>
      <div className="aero-window-body">{props.children}</div>
    </section>
  );
}
