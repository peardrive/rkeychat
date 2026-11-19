/**
 * Activity: the whole feed, with "mark all read". A dock page on the phone, the sidebar's Activity tab on a desktop.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActivityFeed, Button, EmptyState, useToast, type ActivityItem } from '../kit';
import { useStore } from '../store/context';
import { feedUnread, type FeedItem } from '../store/feed';
import { ApprovalDialog, toActivityItems } from './feed';

export function ActivityFeedView({ onNavigate, compact }: { onNavigate?: () => void; compact?: boolean }) {
  const { state, actions } = useStore();
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
  return (
    <View className="w-full">
      <ActivityFeed items={rows} onOpen={open} compact={compact} showWhere emptyState={<EmptyState icon="message" title="Nothing new" description="Approvals, mentions, finished turns, new conversations and files land here." className="py-6" />} />
      <ApprovalDialog item={approval} onClose={() => setApproval(null)} onGrant={grant} onDeny={deny} />
    </View>
  );
}

export function MarkAllRead({ className }: { className?: string }) {
  const { state, dispatch } = useStore();
  const unread = feedUnread(state.feed);
  if (!unread) return null;
  return <Button size="sm" variant="ghost" label={`Mark ${unread} read`} onPress={() => dispatch({ type: 'feedOpenAll' })} className={className} />;
}
