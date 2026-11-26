/**
 * The files shared in a project, newest first, with where each one is on this device.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { getApi } from '../api';
import { Button, FileList, MediaViewer, Text, copyToClipboard, useToast, viewableAttachments, type ChatAttachment, type FileState } from '../kit';
import { rkc } from '../hooks';
import { attachmentOf } from '../store/mapping';
import { useStore } from '../store/context';
import { homeOf } from '../store/selectors';
import { shortTime } from '../time';
import type { FileEntry } from '../types';

export function fileUrl(f: Pick<FileEntry, 'hash' | 'name'>, topic?: string | null) {
  return `/api/file/${f.hash.slice(0, 16)}/${encodeURIComponent(f.name)}${topic ? `?room=${encodeURIComponent(topic)}` : ''}`;
}

/** Hand a file out of the app: the desktop opens a download in the system browser; a phone copies its link. */
export function shareAttachment(a: ChatAttachment, toast: (o: { title: string; description?: string; duration?: number }) => void) {
  if (!a.url) return;
  const dl = `${a.url}${a.url.includes('?') ? '&' : '?'}dl=1`;
  if (rkc()?.desktop || (typeof window !== 'undefined' && !('ontouchstart' in window))) window.open(dl, '_blank');
  else void copyToClipboard(dl).then((ok) => toast({ title: ok ? 'Link copied' : 'Could not copy', description: a.name, duration: 1500 }));
}

export function FilesView({ topic }: { topic: string }) {
  const { state } = useStore();
  const { toast } = useToast();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [fetched, setFetched] = useState<Record<string, boolean>>({});
  const [viewing, setViewing] = useState<number | null>(null);
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
  // the same attachments the chat shows, so the viewer and its pages are the same here
  const items = files.map((f) => attachmentOf({ hash: f.hash, kind: 'file', name: f.name, mime: f.mime, size: f.size, w: f.w, h: f.h, url: f.url }, topic));
  const viewable = new Set(viewableAttachments(items).map((v) => v.index));
  const open = (i: number) => (viewable.has(i) ? setViewing(i) : shareAttachment(items[i]!, toast));

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
        files={files.map((f, i) => ({
          id: f.hash,
          name: f.name,
          size: f.size,
          by: f.by,
          time: shortTime(f.ts),
          state: stateOf(f),
          where: home.here ? undefined : home.name ?? undefined,
          busy: !!busy[f.hash],
          thumbnail: f.mime?.startsWith('image/') ? f.url ?? fileUrl(f, topic) : undefined,
          onOpen: () => open(i),
          onFetch: () => void fetchOne(f),
        }))}
      />
      <MediaViewer open={viewing !== null} items={items} index={viewing ?? 0} onIndexChange={setViewing} onClose={() => setViewing(null)} onShare={(a) => shareAttachment(a, toast)} />
    </View>
  );
}
