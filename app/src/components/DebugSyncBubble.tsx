/**
 * The bubble at the bottom of the screen after a debug note is saved: where the note stands with the Mac, live,
 * until it has arrived (then it goes on its own). One per app, over whatever page is showing; tap to dismiss.
 */
import React, { useEffect } from 'react';
import { SAFE_BOTTOM } from '../hooks';
import { bubbleFor, dismissBubble, startDebugSync, useDebugSync } from '../debugSync';
import { SyncBubble } from '../kit';

/** Above the dock or a composer on the phone; above a composer on the desktop. */
const PHONE_OFFSET = 86;
const DESKTOP_OFFSET = 72;

export function DebugSyncBubble({ phone }: { phone: boolean }) {
  const { sync, shown, now } = useDebugSync();
  useEffect(() => startDebugSync(), []);
  if (!shown) return null;
  const b = bubbleFor(shown.saved, sync, now - shown.since);
  return <SyncBubble state={b.state} label={b.label} detail={b.detail} onPress={dismissBubble} offset={phone ? `calc(${PHONE_OFFSET}px + ${SAFE_BOTTOM})` : DESKTOP_OFFSET} />;
}
