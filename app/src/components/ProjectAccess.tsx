/**
 * "Folders this project can see" (Guy, 2026-11-27: permissions "approved by me safely but within the chat
 * session"): what the project's agents read without asking. The project folder and the folders beside it come with
 * the seat's preset; the rest are the owner's signed grants, added here or by answering an ask "Allow for this
 * project", and removed here. Keys and the `_` business folders are never opened (src/grants.js).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { getApi } from '../api';
import { AccessList, SectionLabel, useToast } from '../kit';
import { accessItems } from '../store/access';
import type { Grant, GrantsInfo } from '../types';

const FOOTNOTE = 'Never opened, whatever is added: keys (~/.ssh and the like), rKeyChat’s own settings, and the _ business folders.';

export function ProjectAccess({ topic, canAdd }: { topic: string; canAdd: boolean }) {
  const { toast } = useToast();
  const [info, setInfo] = useState<GrantsInfo | null>(null);
  const load = useCallback(() => {
    getApi()
      .grants(topic)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [topic]);
  useEffect(() => {
    setInfo(null);
    load();
  }, [load]);
  if (!info) return null;
  const set = (grants: Grant[]) => setInfo((i) => (i ? { ...i, grants } : i));
  return (
    <>
      <SectionLabel label="Folders this project can see" inset="none" className="pb-1.5 pt-4" />
      <AccessList
        items={accessItems(info)}
        footnote={FOOTNOTE}
        lockHint={!info.owner ? "Only the owner's devices can change this" : !canAdd ? 'Add folders from the device that holds the project' : undefined}
        onRemove={
          info.owner
            ? async (it) => {
                try {
                  set((await getApi().grant({ room: topic, rule: it.id, revoke: true })).grants);
                } catch (e) {
                  toast({ title: 'Could not remove it', description: (e as Error).message, tone: 'danger' });
                }
              }
            : undefined
        }
        onAdd={
          info.owner && canAdd
            ? async (folder) => {
                try {
                  set((await getApi().grant({ room: topic, folder })).grants);
                  toast({ title: 'Folder added', description: 'The agents read it without asking from their next step.', tone: 'success', duration: 2500 });
                } catch (e) {
                  toast({ title: 'Could not add that folder', description: (e as Error).message, tone: 'danger' });
                  throw e;
                }
              }
            : undefined
        }
      />
    </>
  );
}
