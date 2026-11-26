import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';

/** The instance type of a React Native TextInput (what `ref` gives). */
export type TextInputRef = React.ComponentRef<typeof TextInput>;

export const PHONE = 720;
export const NARROW = 1040;

/** Window size classes: phone (one column, pages), narrow (right pane hidden by default), desktop. */
export function useViewport() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return { width, phone: width < PHONE, narrow: width < NARROW };
}

export type Shortcut = { key: string; mod?: boolean; shift?: boolean; handler: (e: KeyboardEvent) => void };

/** Global keyboard shortcuts. `mod` is ⌘ on macOS and Ctrl elsewhere. */
export function useShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      for (const s of shortcuts) {
        if (e.key.toLowerCase() !== s.key.toLowerCase()) continue;
        if (!!s.mod !== mod) continue;
        if (!!s.shift !== e.shiftKey) continue;
        s.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts]);
}

/** The Electron preload bridge (electron/preload.cjs), when running inside the desktop app. */
export type RkcBridge = {
  desktop?: boolean;
  platform?: string;
  pathForFile?: (file: File) => string | null | undefined;
  pickFolder?: () => Promise<string | null>;
  openFolder?: (path: string) => void | Promise<void>;
};

export function rkc(): RkcBridge | undefined {
  return (globalThis as unknown as { rkc?: RkcBridge }).rkc;
}

/** A touch-first device (a phone's WebView, a tablet): bigger targets, no drag-drop, no shortcut hints. */
export function isTouch(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

/** iOS safe areas inside a WebView with contentInsetAdjustmentBehavior='never'. CSS env() through RNW styles. */
export const SAFE_TOP = 'env(safe-area-inset-top)';
export const SAFE_BOTTOM = 'env(safe-area-inset-bottom)';

/** The parts of the window a full-screen layer keeps clear of, in px. */
export type Edges = { top: number; bottom: number; left: number; right: number };

/** macOS keeps its traffic lights over the first rows of the window (titleBarStyle hiddenInset): a full-screen layer's bar sits below them. */
export const MAC_TITLE_BAR = 40;

/**
 * What a full-screen layer (the media viewer) keeps clear of: the Mac's title bar with the traffic lights on the
 * desktop app, the phone's notch and home bar in a WebView, nothing in a browser tab. Pure: the measured safe areas
 * come in from `measureSafeInsets()`.
 */
export function viewerInsetsFor({ desktop, platform, safe }: { desktop: boolean; platform?: string; safe: Edges }): Edges {
  if (desktop && platform === 'darwin') return { top: Math.max(MAC_TITLE_BAR, safe.top), bottom: safe.bottom, left: safe.left, right: safe.right };
  return safe;
}

let measured: Edges | null = null;
/** The CSS `env(safe-area-inset-*)` values in px, read once from a probe element (0 where there are none). */
export function measureSafeInsets(): Edges {
  if (measured) return measured;
  const none = { top: 0, bottom: 0, left: 0, right: 0 };
  if (typeof document === 'undefined') return none;
  try {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    measured = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
    el.remove();
    return measured;
  } catch {
    return none;
  }
}

/** The insets the media viewer gets here. */
export function viewerInsets(): Edges {
  return viewerInsetsFor({ desktop: !!rkc()?.desktop, platform: rkc()?.platform, safe: measureSafeInsets() });
}

/** Horizontal swipe on a touch screen (web): `onSwipe(-1)` for right-to-left, `onSwipe(1)` for left-to-right. */
export function useSwipe(onSwipe: (direction: 1 | -1) => void, minPx = 56) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: { nativeEvent: { touches?: { pageX: number; pageY: number }[]; pageX?: number; pageY?: number } }) => {
      const t = e.nativeEvent.touches?.[0] ?? e.nativeEvent;
      start.current = t.pageX != null && t.pageY != null ? { x: t.pageX, y: t.pageY } : null;
    },
    onTouchEnd: (e: { nativeEvent: { changedTouches?: { pageX: number; pageY: number }[]; pageX?: number; pageY?: number } }) => {
      const s = start.current;
      start.current = null;
      const t = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent;
      if (!s || t.pageX == null || t.pageY == null) return;
      const dx = t.pageX - s.x;
      const dy = t.pageY - s.y;
      if (Math.abs(dx) >= minPx && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? -1 : 1);
    },
  };
}

/** Hidden until `ms` have passed: avoids flashing spinners on fast requests. */
export function useDelayed(value: boolean, ms = 250) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}

/**
 * Is the on-screen keyboard up? On a phone the visual viewport shrinks under it while the layout viewport stays:
 * the difference is the keyboard. (main.tsx sizes the root to the visual viewport, so the page itself follows.)
 */
export function useKeyboardOpen(threshold = 100): boolean {
  const read = () => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    return !!vv && window.innerHeight - vv.height > threshold;
  };
  const [open, setOpen] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => setOpen(read());
    vv.addEventListener('resize', onChange);
    window.addEventListener('resize', onChange);
    return () => {
      vv.removeEventListener('resize', onChange);
      window.removeEventListener('resize', onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold]);
  return open;
}
