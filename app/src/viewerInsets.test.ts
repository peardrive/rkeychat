import { describe, expect, it } from 'vitest';
import { MAC_TITLE_BAR, viewerInsetsFor } from './hooks';

const none = { top: 0, bottom: 0, left: 0, right: 0 };

describe('what the viewer keeps clear of', () => {
  it('the Mac app keeps the title bar with its traffic lights clear; a phone keeps its notch; a browser tab nothing', () => {
    expect(viewerInsetsFor({ desktop: true, platform: 'darwin', safe: none })).toEqual({ ...none, top: MAC_TITLE_BAR });
    expect(viewerInsetsFor({ desktop: true, platform: 'linux', safe: none })).toEqual(none);
    expect(viewerInsetsFor({ desktop: false, platform: 'ios', safe: { top: 59, bottom: 34, left: 0, right: 0 } })).toEqual({ top: 59, bottom: 34, left: 0, right: 0 });
    expect(viewerInsetsFor({ desktop: false, safe: none })).toEqual(none);
  });
});
