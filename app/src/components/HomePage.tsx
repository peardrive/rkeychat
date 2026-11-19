/**
 * Home on a desktop's middle pane: the whole activity feed.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActivityFeed, Button, EmptyState, Pane, PaneBody, PaneHeader, useToast, type ActivityItem } from '../kit';
import { useStore } from '../store/context';
import { feedUnread, type FeedItem } from '../store/feed';
import { ApprovalDialog, toActivityItems } from './feed';

export function HomePage({ onNavigate }: { onNavigate?: () => void }) {
  const { state, actions, dispatch } = useStore();
  const { toast } = useToast();
  const [approval, setApproval] = useState<FeedItem | null>(null);
  const grant = useCallback((topic: string) => actions.loginGrant(topic).then(() => toast({ title: 'Let in', tone: 'success' })).catch((e) => toast({ title: 'Could not let them in', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const deny = useCallback((topic: string) => actions.loginDeny(topic).catch((e) => toast({ title: 'Could not answer', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const rows = useMemo(() => toActivityItems(state.feed, grant), [state.feed, grant]);
  const open = (item: ActivityItem) => {
    const f = state.feed.find((x) => x.id === item.id);
    if (f?.kind === 'approval') return setApproval(f);
    void actions.openFeedItem(item.id);
    onNavigate?.();
  };
  const unread = feedUnread(state.feed);
  return (
    <Pane glow>
      <PaneHeader title="Home" subtitle={unread ? `${unread} new` : 'Nothing waiting on you'} dragRegion actions={unread ? <Button size="sm" variant="ghost" label="Mark all read" onPress={() => dispatch({ type: 'feedOpenAll' })} className="app-region-no-drag" /> : undefined} />
      <PaneBody contentClassName="px-3 pb-6 pt-1">
        <View className="w-full max-w-[720px] self-center">
          <ActivityFeed items={rows} onOpen={open} emptyState={<EmptyState icon="message" title="Nothing new" description="Approvals, mentions, finished turns, new conversations and files land here." />} />
        </View>
      </PaneBody>
      <ApprovalDialog item={approval} onClose={() => setApproval(null)} onGrant={grant} onDeny={deny} />
    </Pane>
  );
}
