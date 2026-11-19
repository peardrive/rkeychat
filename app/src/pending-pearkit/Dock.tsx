/**
 * Stand-in for PearKit `Dock` / `DockButton`: a glassy pill at the bottom with embossed buttons, like the
 * iPhone Photos dock. Same props as the PearKit version being written.
 */
import React from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { CountBadge, Icon, Text, cn, type IconSource, renderIcon } from 'pearkit';

export interface DockItem {
  key: string;
  icon: IconSource;
  label: string;
  badge?: number;
}

export interface DockProps {
  items: DockItem[];
  value: string;
  onChange: (key: string) => void;
  /** Safe-area inset under the dock (px or a CSS length on the web). */
  inset?: number | string;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

export function DockButton({ item, active, onPress }: { item: DockItem; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={cn('h-11 min-w-[64px] flex-1 items-center justify-center gap-0.5 rounded-full', active ? 'bg-overlay/[0.12]' : 'active:bg-overlay/[0.06]', Platform.OS === 'web' && 'cursor-pointer select-none')}
      style={active ? ({ boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.10), 0px 1px 2px rgba(0,0,0,0.35)' } as never) : undefined}
    >
      <View>
        {renderIcon(item.icon, { size: 20, tone: active ? 'foreground' : 'icon' })}
        {item.badge ? (
          <View className="absolute -right-2.5 -top-1.5">
            <CountBadge value={item.badge} tone="warning" />
          </View>
        ) : null}
      </View>
      <Text variant="micro" weight={active ? 'semibold' : 'medium'} tone={active ? 'foreground' : 'subtle'}>
        {item.label}
      </Text>
    </Pressable>
  );
}

export function Dock({ items, value, onChange, inset = 0, className, style }: DockProps) {
  return (
    <View pointerEvents="box-none" className={cn('absolute inset-x-0 bottom-0 z-20 items-center px-4 pt-2', className)} style={[{ paddingBottom: inset } as ViewStyle, style]}>
      <View
        accessibilityRole={Platform.OS === 'web' ? ('tablist' as never) : undefined}
        className="w-full max-w-[420px] flex-row items-center gap-1 rounded-full border border-overlay/[0.12] bg-pane/80 p-1"
        style={[
          { boxShadow: '0px 10px 30px rgba(0,0,0,0.45), inset 0px 1px 0px rgba(255,255,255,0.06)' } as never,
          Platform.OS === 'web' ? ({ backdropFilter: 'blur(22px) saturate(1.5)', WebkitBackdropFilter: 'blur(22px) saturate(1.5)' } as never) : null,
        ]}
      >
        {items.map((it) => (
          <DockButton key={it.key} item={it} active={it.key === value} onPress={() => onChange(it.key)} />
        ))}
      </View>
    </View>
  );
}

void Icon;
