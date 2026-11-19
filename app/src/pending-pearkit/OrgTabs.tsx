/**
 * Stand-in for PearKit `OrgTabs`: a row of organizations as pills with their avatar, the active one lit.
 * Same props as the PearKit version being written.
 */
import React from 'react';
import { Platform, Pressable, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { Avatar, Icon, Text, cn } from 'pearkit';

export interface OrgTabItem {
  key: string;
  name: string;
  /** Avatar seed; the name when left out. `null` for a tab without one (All). */
  avatar?: string | null;
  count?: number;
}

export interface OrgTabsProps {
  items: OrgTabItem[];
  value: string;
  onChange: (key: string) => void;
  /** A + at the end (a new organization). */
  onAdd?: () => void;
  size?: 'sm' | 'md';
  className?: string;
  style?: StyleProp<ViewStyle>;
}

export function OrgTabs({ items, value, onChange, onAdd, size = 'md', className, style }: OrgTabsProps) {
  const h = size === 'sm' ? 'h-8' : 'h-9';
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className={cn('w-full flex-grow-0', className)} style={style} contentContainerClassName="flex-row items-center gap-1.5 px-3 py-1">
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityLabel={it.name}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(it.key)}
            className={cn('flex-row items-center gap-1.5 rounded-full border pl-1 pr-3', h, on ? 'border-primary/40 bg-primary/[0.14]' : 'border-overlay/[0.08] bg-overlay/5 hover:bg-overlay/[0.08]', Platform.OS === 'web' && 'cursor-pointer select-none')}
          >
            {it.avatar === null ? (
              <View className={cn('items-center justify-center rounded-full bg-overlay/10', size === 'sm' ? 'h-6 w-6' : 'h-7 w-7')}>
                <Icon name="grid-1" size={13} tone={on ? 'primary-text' : 'icon'} />
              </View>
            ) : (
              <Avatar seed={it.avatar ?? `org:${it.name}`} size={size === 'sm' ? 24 : 28} label={it.name} />
            )}
            <Text variant={size === 'sm' ? 'label' : 'body'} weight={on ? 'semibold' : 'medium'} tone={on ? 'primary-text' : 'foreground'} numberOfLines={1}>
              {it.name}
            </Text>
            {it.count != null ? (
              <Text variant="micro" tone={on ? 'primary-text' : 'subtle'}>
                {it.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      {onAdd ? (
        <Pressable accessibilityRole="button" accessibilityLabel="New organization" onPress={onAdd} className={cn('items-center justify-center rounded-full border border-dashed border-overlay/[0.14]', h, size === 'sm' ? 'w-8' : 'w-9', Platform.OS === 'web' && 'cursor-pointer')}>
          <Icon name="add" size={15} tone="icon" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
