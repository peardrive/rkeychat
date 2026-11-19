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
