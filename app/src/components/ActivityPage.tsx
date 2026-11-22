/**
 * Activity: the recent conversations (the Home block's list, longer) and then the whole feed, with "mark all
 * read". A dock page on the phone, the sidebar's Activity tab on a desktop.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActivityFeed, Button, EmptyState, Icon, SidebarThreadItem, Text, useToast, type ActivityItem } from '../kit';
import { useStore } from '../store/context';
import { feedUnread, type FeedItem } from '../store/feed';
import { recentConversations, type RecentConversation } from '../store/home';
import { convTitle, thinkingIn, unreadIn } from '../store/selectors';
import { shortTime } from '../time';
import { ApprovalDialog, toActivityItems } from './feed';

/** The recent conversations as rows: project · conversation, the last line, the time, unread and live marks. */
export function RecentList({ items, onNavigate }: { items: RecentConversation[]; onNavigate?: () => void }) {
  const { state, actions } = useStore();
  if (!items.length) {
    return (
      <Text variant="caption" tone="subtle">
        No conversation yet.
      </Text>
    );
  }
  return (
    <View className="-mx-1 gap-px">
      {items.map((r) => (
        <SidebarThreadItem
          key={`${r.topic}/${r.conv.conv}`}
          nested={false}
          title={`${r.room} · ${convTitle(r.conv)}`}
          snippet={r.conv.last ? `${r.conv.last.name}: ${r.conv.last.text}` : undefined}
          time={shortTime(r.ts)}
          unread={unreadIn(state, r.topic, r.conv.conv)}
          live={thinkingIn(state, r.topic, r.conv.conv).length > 0}
          onPress={() => {
            void actions.select(r.topic, r.conv.conv);
            onNavigate?.();
          }}
        />
      ))}
    </View>
  );
}

/** The Activity page's first section: the `n` most recent conversations under a small heading. */
export function RecentConversations({ n = 12, onNavigate }: { n?: number; onNavigate?: () => void }) {
  const { state } = useStore();
  const recent = useMemo(() => recentConversations(state, n), [state, n]);
  if (!recent.length) return null;
  return (
    <View className="gap-1.5 px-1">
      <View className="flex-row items-center gap-2 px-1">
        <Icon name="message-fill" size={14} tone="icon-strong" emboss />
        <Text variant="label" weight="semibold" tone="muted">
          Recent
        </Text>
      </View>
      <RecentList items={recent} onNavigate={onNavigate} />
    </View>
  );
}

export function ActivityFeedView({ onNavigate, compact }: { onNavigate?: () => void; compact?: boolean }) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [approval, setApproval] = useState<FeedItem | null>(null);
  const grant = useCallback((topic: string) => actions.loginGrant(topic).then(() => toast({ title: 'Let in', tone: 'success' })).catch((e) => toast({ title: 'Could not let them in', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const deny = useCallback((topic: string) => actions.loginDeny(topic).catch((e) => toast({ title: 'Could not answer', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const answer = useCallback((topic: string, ask: string, choice: string) => actions.answerAsk(topic, ask, choice).then(() => toast({ title: choice.startsWith('allow') ? 'Allowed' : 'Denied', tone: 'success' })).catch((e) => toast({ title: 'Could not answer', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const rows = useMemo(() => toActivityItems(state.feed, grant, answer), [state.feed, grant, answer]);
  const open = (item: ActivityItem) => {
    const f = state.feed.find((x) => x.id === item.id);
    if (f?.kind === 'approval') return setApproval(f);
    void actions.openFeedItem(item.id);
    onNavigate?.();
  };
  return (
    <View className="w-full">
      <ActivityFeed items={rows} onOpen={open} compact={compact} showWhere emptyState={<EmptyState icon="bell-fill" title="Nothing new" description="Approvals, mentions, finished turns, new projects and conversations, and files land here." className="py-6" />} />
      <ApprovalDialog item={approval} onClose={() => setApproval(null)} onGrant={grant} onDeny={deny} onAnswer={answer} />
    </View>
  );
}

export function MarkAllRead({ className }: { className?: string }) {
  const { state, dispatch } = useStore();
  const unread = feedUnread(state.feed);
  if (!unread) return null;
  return <Button size="sm" variant="ghost" label={`Mark ${unread} read`} onPress={() => dispatch({ type: 'feedOpenAll' })} className={className} />;
}
