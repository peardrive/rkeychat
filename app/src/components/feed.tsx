/**
 * The store's feed items as PearKit `ActivityItem`s, and the approval dialog an approval opens.
 */
import React from 'react';
import { View } from 'react-native';
import { Button, Dialog, Text, type ActivityItem } from '../kit';
import type { FeedItem } from '../store/feed';

export function toActivityItems(feed: FeedItem[], grant: (topic: string) => void, answer?: (topic: string, ask: string, choice: string) => void): ActivityItem[] {
  return feed.map((f) => ({
    id: f.id,
    ts: f.ts,
    kind: f.kind,
    title: f.title,
    detail: f.text,
    who: f.who ? { id: f.who, name: f.who, agent: f.whoAgent } : undefined,
    where: f.where,
    unread: f.unread,
    action: f.kind === 'approval' && f.ask ? { label: 'Let in', onPress: () => grant(f.ask!.topic) } : f.kind === 'approval' && f.permission && answer ? { label: 'Allow once', onPress: () => answer(f.permission!.topic, f.permission!.id, 'allow_once') } : undefined,
  }));
}

export function ApprovalDialog({ item, onClose, onGrant, onDeny, onAnswer }: { item: FeedItem | null; onClose: () => void; onGrant: (topic: string) => void; onDeny: (topic: string) => void; onAnswer?: (topic: string, ask: string, choice: string) => void }) {
  const ask = item?.ask;
  const perm = item?.permission;
  if (perm) {
    const say = (choice: string) => { onAnswer?.(perm.topic, perm.id, choice); onClose(); };
    return (
      <Dialog
        open
        onClose={onClose}
        icon="robot"
        title={`${item?.who ?? 'An agent'} asks for ${perm.tool}`}
        description="Only your own devices can answer. The answer is signed with this device's key and goes into the conversation."
        actions={
          <>
            <Button label="Refuse" variant="danger" onPress={() => say('reject_once')} />
            {perm.always ? <Button label="Allow for this project" variant="secondary" onPress={() => say('allow_always')} /> : null}
            <Button label="Allow once" variant="primary" onPress={() => say('allow_once')} />
          </>
        }
      >
        <Text variant="body-sm" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {perm.what}
        </Text>
        {perm.always ? (
          <Text variant="caption" tone="muted" className="pt-2">
            For this project: {perm.always}
          </Text>
        ) : null}
      </Dialog>
    );
  }
  return (
    <Dialog
      open={!!ask}
      onClose={onClose}
      icon="alert-circle"
      title={item ? `${item.who ?? ''} ${item.title}`.trim() : ''}
      description={ask ? `${ask.deviceName} is knocking${ask.room ? ` at ${ask.room}` : ''}. Compare the device name with the other screen before letting it in.` : undefined}
      actions={
        ask ? (
          <>
            <Button label="No" variant="danger" onPress={() => { onDeny(ask.topic); onClose(); }} />
            <Button label="Let in" variant="primary" onPress={() => { onGrant(ask.topic); onClose(); }} />
          </>
        ) : null
      }
    >
      {ask ? (
        <View className="gap-1">
          <Text variant="caption" tone="muted">
            As: {ask.names?.map((n) => `${n.name} (${n.role})`).join(', ') || 'nobody named'}
          </Text>
          <Text variant="micro" tone="subtle" numberOfLines={1}>
            {ask.device}
          </Text>
        </View>
      ) : null}
    </Dialog>
  );
}
