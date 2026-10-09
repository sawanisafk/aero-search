/**
 * App — the Aero desktop: window manager + taskbar + start menu.
 *
 * WHAT: owns every window's geometry/z-order/minimized state, the desktop
 *   icons, the start menu, and the taskbar clock. Each window body is one
 *   of the view components (search/doc/evaluation/status/settings); App
 *   itself never talks to the API.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AeroWindow } from './windows/AeroWindow';
import { SearchWindow } from './windows/SearchWindow';
import { DocWindow } from './windows/DocWindow';
import { EvaluationWindow } from './windows/EvaluationWindow';
import { StatusWindow } from './windows/StatusWindow';
import { SettingsWindow } from './windows/SettingsWindow';
import {
  ChartIcon,
  DocIcon,
  GearIcon,
  GaugeIcon,
  SearchIcon,
  StartOrbGlyph,
} from './components/Icons';

type WinKind = 'search' | 'doc' | 'evaluation' | 'status' | 'settings';

interface DocPayload {
  readonly corpus: string;
  readonly docId: string;
  readonly q: string;
}

interface WinState {
  readonly key: string;
  readonly kind: WinKind;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly payload: DocPayload | null;
}

interface ViewSpec {
  readonly kind: WinKind;
  readonly title: string;
  readonly desc: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const VIEWS: Readonly<Record<WinKind, ViewSpec>> = {
  search: { kind: 'search', title: 'Aero Search', desc: 'query the inverted index', x: 132, y: 34, w: 940, h: 660 },
  doc: { kind: 'doc', title: 'Document', desc: 'full document view', x: 186, y: 62, w: 800, h: 580 },
  evaluation: { kind: 'evaluation', title: 'Evaluation', desc: 'recorded experiments — MAP, nDCG, latency', x: 96, y: 28, w: 980, h: 660 },
  status: { kind: 'status', title: 'System Status', desc: 'index, strategies, PageRank', x: 224, y: 66, w: 780, h: 600 },
  settings: { kind: 'settings', title: 'Settings', desc: 'configuration and endpoints', x: 268, y: 88, w: 680, h: 560 },
};

const MENU_ITEMS: readonly WinKind[] = ['search', 'evaluation', 'status', 'settings'];

function iconFor(kind: WinKind): ReactNode {
  switch (kind) {
    case 'search':
      return <SearchIcon size={20} />;
    case 'doc':
      return <DocIcon size={20} />;
    case 'evaluation':
      return <ChartIcon size={20} />;
    case 'status':
      return <GaugeIcon size={20} />;
    case 'settings':
      return <GearIcon size={20} />;
  }
}

export function App(): React.JSX.Element {
  const [windows, setWindows] = useState<WinState[]>(() => [
    { ...VIEWS.search, key: 'search', z: 20, minimized: false, maximized: false, payload: null },
  ]);
  const [focusedKey, setFocusedKey] = useState<string>('search');
  const [startOpen, setStartOpen] = useState(false);
  const zRef = useRef(21);

  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const focus = (key: string): void => {
    const z = zRef.current++;
    setFocusedKey(key);
    setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, z, minimized: false } : w)));
  };

  const openView = (kind: WinKind): void => {
    setStartOpen(false);
    const existing = windows.find((w) => w.kind === kind);
    if (existing !== undefined) {
      focus(existing.key);
      return;
    }
    const cascade = (windows.length % 5) * 26;
    const spec = VIEWS[kind];
    const key = kind;
    setFocusedKey(key);
    setWindows((ws) => [
      ...ws,
      {
        key,
        kind,
        title: spec.title,
        x: spec.x + cascade,
        y: spec.y + cascade,
        w: spec.w,
        h: spec.h,
        z: zRef.current++,
        minimized: false,
        maximized: false,
        payload: null,
      },
    ]);
  };

  const openDoc = (corpus: string, docId: string, q: string): void => {
    const key = `doc:${corpus}:${docId}`;
    setStartOpen(false);
    const existing = windows.find((w) => w.key === key);
    if (existing !== undefined) {
      setWindows((ws) =>
        ws.map((w) => (w.key === key ? { ...w, payload: { corpus, docId, q } } : w)),
      );
      focus(key);
      return;
    }
    const cascade = (windows.length % 5) * 26;
    const spec = VIEWS.doc;
    setFocusedKey(key);
    setWindows((ws) => [
      ...ws,
      {
        key,
        kind: 'doc',
        title: `Document · ${docId}`,
        x: spec.x + cascade,
        y: spec.y + cascade,
        w: spec.w,
        h: spec.h,
        z: zRef.current++,
        minimized: false,
        maximized: false,
        payload: { corpus, docId, q },
      },
    ]);
  };

  const close = (key: string): void => {
    setWindows((ws) => ws.filter((w) => w.key !== key));
    if (focusedKey === key) setFocusedKey('');
  };
  const minimize = (key: string): void => {
    setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, minimized: true } : w)));
    if (focusedKey === key) setFocusedKey('');
  };
  const toggleMaximize = (key: string): void => {
    focus(key);
    setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, maximized: !w.maximized } : w)));
  };
  const move = (key: string, x: number, y: number): void => {
    setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, x, y } : w)));
  };

  const clickTaskbar = (w: WinState): void => {
    if (focusedKey === w.key && !w.minimized) minimize(w.key);
    else focus(w.key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setStartOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  const bodyFor = (w: WinState): ReactNode => {
    switch (w.kind) {
      case 'search':
        return <SearchWindow onOpenDoc={openDoc} />;
      case 'doc':
        return (
          <DocWindow
            corpus={w.payload?.corpus ?? 'cqadupstack-tierb'}
            docId={w.payload?.docId ?? ''}
            q={w.payload?.q ?? ''}
          />
        );
      case 'evaluation':
        return <EvaluationWindow />;
      case 'status':
        return <StatusWindow />;
      case 'settings':
        return <SettingsWindow />;
    }
  };

  return (
    <div className="desktop" onClick={() => setStartOpen(false)}>
      <div className="desktop-icons">
        {MENU_ITEMS.map((kind) => (
          <button
            className="desktop-icon"
            key={kind}
            onClick={() => openView(kind)}
            onDoubleClick={() => openView(kind)}
          >
            <span className="tile">{iconFor(kind)}</span>
            <span className="label">{VIEWS[kind].title}</span>
          </button>
        ))}
      </div>

      <div className="desktop-brand">
        <h1>Aero Search</h1>
        <p>custom index · bm25 · pagerank · fuzzy</p>
      </div>

      {windows
        .filter((w) => !w.minimized)
        .map((w) => (
          <AeroWindow
            key={w.key}
            title={w.title}
            icon={iconFor(w.kind)}
            x={w.x}
            y={w.y}
            w={w.w}
            h={w.h}
            z={w.z}
            focused={focusedKey === w.key}
            maximized={w.maximized}
            onFocus={() => focus(w.key)}
            onClose={() => close(w.key)}
            onMinimize={() => minimize(w.key)}
            onToggleMaximize={() => toggleMaximize(w.key)}
            onMove={(x, y) => move(w.key, x, y)}
          >
            {bodyFor(w)}
          </AeroWindow>
        ))}

      {startOpen && (
        <div className="start-menu" onClick={(e) => e.stopPropagation()}>
          <header>Aero Search</header>
          <ul className="start-menu-list">
            {MENU_ITEMS.map((kind) => (
              <li key={kind}>
                <button className="start-menu-item" onClick={() => openView(kind)}>
                  <span className="tile">{iconFor(kind)}</span>
                  <span>
                    <span className="title">{VIEWS[kind].title}</span>
                    <div className="desc">{VIEWS[kind].desc}</div>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <footer>
            <span>custom IR engine</span>
            <span>M5 · final build</span>
          </footer>
        </div>
      )}

      <div className="taskbar" onClick={(e) => e.stopPropagation()}>
        <button
          className={`start-orb${startOpen ? ' open' : ''}`}
          aria-label="Start"
          onClick={() => setStartOpen((o) => !o)}
        >
          <StartOrbGlyph />
        </button>
        <div className="taskbar-buttons">
          {windows.map((w) => (
            <button
              key={w.key}
              className={[
                'taskbar-btn',
                focusedKey === w.key && !w.minimized ? 'active' : '',
                w.minimized ? 'minimized' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => clickTaskbar(w)}
            >
              {iconFor(w.kind)}
              <span>{w.title}</span>
            </button>
          ))}
        </div>
        <div className="taskbar-clock">
          <div>{time}</div>
          <div className="date">{date}</div>
        </div>
      </div>
    </div>
  );
}
