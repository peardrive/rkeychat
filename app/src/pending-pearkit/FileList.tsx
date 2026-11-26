/**
 * A list of the files shared in a project with where each one is (projects-home-and-sync.md §3).
 * Built from PearKit `Thumbnail`, `Text`, `Chip`, `Button`; a candidate for PearKit as `FileRow`.
 */
import React from 'react';
import { View } from 'react-native';
import { Button, Chip, EmptyState, Text, Thumbnail, cn, fileKindFromName, formatBytes } from 'pearkit';

export type FileState = 'here' | 'fetched' | 'away' | 'unavailable';

export interface FileRowProps {
  name: string;
  size?: number;
  by?: string;
  time?: string;
  state: FileState;
  /** Where it is when not here ("on macbook"). */
  where?: string;
  busy?: boolean;
  /** A small picture of it (the file itself when it is an image). */
  thumbnail?: string;
  onOpen?: () => void;
  onFetch?: () => void;
  className?: string;
}

const stateMeta: Record<FileState, { label: (where?: string) => string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = {
  here: { label: () => 'here', tone: 'success' },
  fetched: { label: () => 'fetched', tone: 'info' },
  away: { label: (w) => (w ? `on ${w}` : 'elsewhere'), tone: 'neutral' },
  unavailable: { label: (w) => (w ? `unavailable, last on ${w}` : 'unavailable'), tone: 'warning' },
};

export function FileRow({ name, size, by, time, state, where, busy, thumbnail, onOpen, onFetch, className }: FileRowProps) {
  const m = stateMeta[state];
  const meta = [size ? formatBytes(size) : null, by, time].filter(Boolean).join(' · ');
  return (
    <View className={cn('w-full flex-row items-center gap-3 rounded-md px-2 py-2 hover:bg-overlay/[0.04]', className)}>
      <Thumbnail source={thumbnail} kind={fileKindFromName(name)} size={36} />
      <View className="min-w-0 flex-1 gap-px">
        <Text variant="body-lg" numberOfLines={1}>
          {name}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <Text variant="caption" tone="subtle" numberOfLines={1} className="min-w-0 shrink">
            {meta}
          </Text>
          <Chip size="sm" label={m.label(where)} tone={m.tone} selected />
        </View>
      </View>
      {state === 'here' || state === 'fetched' ? <Button size="sm" variant="subtle" label="Open" onPress={onOpen} /> : state === 'away' ? <Button size="sm" variant="subtle" label="Fetch" loading={busy} onPress={onFetch} /> : null}
    </View>
  );
}

export interface FileListProps {
  files: (FileRowProps & { id: string })[];
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

export function FileList({ files, emptyTitle = 'No files yet', emptyDescription = 'Files shared in this project show here, with where each one is.', className }: FileListProps) {
  if (!files.length) return <EmptyState icon="document" title={emptyTitle} description={emptyDescription} />;
  return (
    <View className={cn('w-full gap-px', className)}>
      {files.map(({ id, ...f }) => (
        <FileRow key={id} {...f} />
      ))}
    </View>
  );
}
