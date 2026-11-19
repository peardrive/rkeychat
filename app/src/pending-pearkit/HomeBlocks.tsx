/**
 * Stand-ins for PearKit `HomeBlock` / `HomeGrid` / `PresenceRow`, the block style of the old PearDrive mobile home.
 * Same props as the PearKit versions being written.
 */
import React from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Avatar, Button, CountBadge, Icon, StatusDot, Text, cn, type IconSource, renderIcon } from 'pearkit';

export interface HomeBlockProps {
  title: string;
  icon?: IconSource;
  count?: number;
  /** A small action at the right of the title. */
  action?: { label: string; onPress: () => void };
  /** `half` sits two to a row in a HomeGrid; `full` spans. Default `full`. */
  size?: 'half' | 'full';
  onPress?: () => void;
  children?: React.ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

export function HomeBlock({ title, icon, count, action, size = 'full', onPress, children, className, style }: HomeBlockProps) {
  const Comp = onPress ? Pressable : View;
  return (
    <Comp
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? title : undefined}
      onPress={onPress}
      className={cn('gap-2.5 rounded-card border border-overlay/[0.07] bg-overlay/[0.04] p-3.5', size === 'half' ? 'min-w-[46%] flex-1' : 'w-full', onPress && 'hover:bg-overlay/[0.06] active:bg-overlay/[0.08]', onPress && Platform.OS === 'web' && 'cursor-pointer', className)}
      style={[{ boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.04)' } as never, style]}
    >
      <View className="flex-row items-center gap-2">
        {icon ? renderIcon(icon, { size: 15, tone: 'icon' }) : null}
        <Text variant="body-lg" numberOfLines={1} className="min-w-0 flex-1">
          {title}
        </Text>
        {count ? <CountBadge value={count} tone="warning" /> : null}
        {action ? <Button size="sm" variant="ghost" label={action.label} onPress={action.onPress} /> : onPress ? <Icon name="chevron-right" size={13} tone="subtle" /> : null}
      </View>
      {children}
    </Comp>
  );
}

export interface HomeGridProps {
  children?: React.ReactNode;
  /** Blocks per row for `half` blocks. Default 2. */
  columns?: number;
  className?: string;
}

export function HomeGrid({ children, className }: HomeGridProps) {
  return <View className={cn('w-full flex-row flex-wrap gap-2.5', className)}>{children}</View>;
}

export interface PresencePerson {
  id: string;
  name: string;
  agent?: boolean;
  online: boolean;
  avatar?: string;
}

export interface PresenceRowProps {
  people: PresencePerson[];
  /** Show at most this many, then "+n". Default 8. */
  max?: number;
  onPress?: (person: PresencePerson) => void;
  className?: string;
}

export function PresenceRow({ people, max = 8, onPress, className }: PresenceRowProps) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  if (!people.length) {
    return (
      <Text variant="caption" tone="subtle">
        Nobody online.
      </Text>
    );
  }
  return (
    <View className={cn('flex-row flex-wrap gap-x-3 gap-y-2', className)}>
      {shown.map((p) => (
        <Pressable key={p.id} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={p.name} onPress={onPress ? () => onPress(p) : undefined} className={cn('w-[52px] items-center gap-1', !p.online && 'opacity-50', onPress && Platform.OS === 'web' && 'cursor-pointer')}>
          <View>
            <Avatar seed={p.avatar ?? p.id} size={40} label={p.name} />
            <View className="absolute -bottom-px -right-px rounded-full bg-pane p-0.5">
              <StatusDot tone={p.online ? 'success' : 'neutral'} size={8} />
            </View>
            {p.agent ? (
              <View className="absolute -left-1 -top-1 rounded-full bg-pane p-0.5">
                <Icon name="people" size={11} tone="primary-text" />
              </View>
            ) : null}
          </View>
          <Text variant="micro" tone={p.online ? 'foreground' : 'subtle'} numberOfLines={1} className="max-w-full">
            {p.name}
          </Text>
        </Pressable>
      ))}
      {more > 0 ? (
        <View className="w-[52px] items-center justify-center">
          <Text variant="caption" tone="subtle">
            +{more}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
