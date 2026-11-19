/**
 * The files shared in a project, newest first, with where each one is on this device.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { getApi } from '../api';
import { Button, FileList, Text, useToast, type FileState } from '../kit';
import { useStore } from '../store/context';
import { homeOf } from '../store/selectors';
import { shortTime } from '../time';
import type { FileEntry } from '../types';

export function fileUrl(f: Pick<FileEntry, 'hash' | 'name'>) {
  return `/api/file/${f.hash.slice(0, 16)}/${encodeURIComponent(f.name)}`;
}

export function FilesView({ topic }: { topic: string }) {
  const { state } = useStore();
  const { toast } = useToast();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [fetched, setFetched] = useState<Record<string, boolean>>({});
  const room = state.rooms[topic];
  const home = homeOf(room, state.me?.ref);

  const load = useCallback(async () => {
    try {
      const list = await getApi().files(topic);
      setFiles(list.sort((a, b) => b.ts - a.ts));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setFiles([]);
    }
  }, [topic]);

  useEffect(() => {
    setFiles(null);
    void load();
  }, [load]);

  // A new file in a message: refresh.
  const thread = state.threads[`${topic}/${state.selected.conv ?? 'main'}`];
  const fileCount = thread?.items.reduce((n, r) => n + (r.att?.filter((a) => a.kind === 'file').length ?? 0), 0) ?? 0;
  useEffect(() => {
    if (files) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCount]);

  const fetchOne = async (f: FileEntry) => {
    setBusy((b) => ({ ...b, [f.hash]: true }));
    try {
      await getApi().fetchFile({ room: topic, hash: f.hash });
      setFetched((x) => ({ ...x, [f.hash]: true }));
      toast({ title: 'Fetched', description: f.name, tone: 'success', duration: 2000 });
    } catch (e) {
      toast({ title: `Could not fetch ${f.name}`, description: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy((b) => ({ ...b, [f.hash]: false }));
    }
  };

  if (!files) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  const stateOf = (f: FileEntry): FileState => (f.local ? (fetched[f.hash] ? 'fetched' : 'here') : f.providers > 0 ? 'away' : 'unavailable');

  return (
    <View className="flex-1 px-2 pb-3 pt-1">
      {error ? (
        <View className="items-center gap-2 py-4">
          <Text variant="caption" tone="danger">
            {error}
          </Text>
          <Button size="sm" label="Retry" onPress={load} />
        </View>
      ) : null}
      <FileList
        files={files.map((f) => ({
          id: f.hash,
          name: f.name,
          size: f.size,
          by: f.by,
          time: shortTime(f.ts),
          state: stateOf(f),
          where: home.here ? undefined : home.name ?? undefined,
          busy: !!busy[f.hash],
          onOpen: () => void window.open(fileUrl(f), '_blank'),
          onFetch: () => void fetchOne(f),
        }))}
      />
    </View>
  );
}
