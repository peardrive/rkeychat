/**
 * Home's blocks: what needs you, recent conversations, organizations, who is online.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { getApi } from '../api';
import { ActivityFeed, Avatar, HomeBlock, HomeGrid, PresenceRow, Text, cn, useToast, type ActivityItem } from '../kit';
import { useStore } from '../store/context';
import { feedUnread, type FeedItem } from '../store/feed';
import { needsYou, onlineNow, orgSummaries, recentConversations } from '../store/home';
import { orderedRooms } from '../store/selectors';
import type { Person } from '../types';
import { RecentList } from './ActivityPage';
import { ApprovalDialog, toActivityItems } from './feed';

export interface HomeBlocksProps {
  /** Open Projects, filtered to an organization (or all). */
  onOpenProjects: (org?: string) => void;
  onOpenActivity: () => void;
  onOpenProfile?: (name: string) => void;
  onNavigate?: () => void;
  compact?: boolean;
}

export function HomeBlocks({ onOpenProjects, onOpenActivity, onOpenProfile, onNavigate, compact }: HomeBlocksProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [approval, setApproval] = useState<FeedItem | null>(null);
  const [people, setPeople] = useState<{ local: Person[]; known: Person[] } | null>(null);

  useEffect(() => {
    getApi().people().then(setPeople).catch(() => {});
  }, []);

  const grant = useCallback((topic: string) => actions.loginGrant(topic).then(() => toast({ title: 'Let in', tone: 'success' })).catch((e) => toast({ title: 'Could not let them in', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const deny = useCallback((topic: string) => actions.loginDeny(topic).catch((e) => toast({ title: 'Could not answer', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const needs = useMemo(() => needsYou(state.feed), [state.feed]);
  const needsItems = useMemo(() => toActivityItems(needs, grant), [needs, grant]);
  const openItem = (item: ActivityItem) => {
    const f = state.feed.find((x) => x.id === item.id);
    if (f?.kind === 'approval') return setApproval(f);
    void actions.openFeedItem(item.id);
    onNavigate?.();
  };
  const recent = useMemo(() => recentConversations(state, compact ? 3 : 5), [state]);
  const rooms = orderedRooms(state);
  const orgs = useMemo(() => orgSummaries(rooms), [rooms]);
  const online = useMemo(() => onlineNow(state, people), [state, people]);
  const unread = feedUnread(state.feed);

  return (
    <HomeGrid columns={compact ? 1 : undefined}>
      <HomeBlock title="Needs you" icon="alert-circle" size="wide" count={needs.length || undefined} action={unread ? { label: `Activity · ${unread}`, onPress: onOpenActivity } : undefined}>
        {needs.length ? (
          <ActivityFeed items={needsItems} onOpen={openItem} compact groupByDay={false} showWhere={!compact} />
        ) : (
          <Text variant="caption" tone="subtle">
            Nothing waiting on you.
          </Text>
        )}
      </HomeBlock>

      <HomeBlock title="Recent" icon="message-fill" size="wide" action={{ label: 'Activity', onPress: onOpenActivity }}>
        <RecentList items={recent} onNavigate={onNavigate} />
      </HomeBlock>

      <HomeBlock title="Organizations" icon="group" action={{ label: 'All', onPress: () => onOpenProjects() }}>
        {orgs.length ? (
          <View className="flex-row flex-wrap gap-x-3 gap-y-2">
            {orgs.map((o) => (
              <Pressable key={o.name} accessibilityRole="button" accessibilityLabel={`${o.name} projects`} onPress={() => onOpenProjects(o.name)} className={cn('w-[56px] items-center gap-1', Platform.OS === 'web' && 'cursor-pointer')}>
                <Avatar seed={o.seed} size={40} label={o.name} />
                <Text variant="micro" numberOfLines={1} className="max-w-full">
                  {o.name}
                </Text>
                <Text variant="micro" tone="subtle">
                  {o.count}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text variant="caption" tone="subtle">
            None yet. Projects can be grouped under one.
          </Text>
        )}
      </HomeBlock>

      <HomeBlock title="Online" icon="people">
        <PresenceRow people={online.map((p) => ({ ...p, avatar: { seed: p.id } }))} max={compact ? 6 : 10} size={36} onPress={onOpenProfile ? (id) => onOpenProfile(id) : undefined} />
      </HomeBlock>

      <ApprovalDialog item={approval} onClose={() => setApproval(null)} onGrant={grant} onDeny={deny} />
    </HomeGrid>
  );
}
