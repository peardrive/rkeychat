/**
 * First run, one thing at a time (docs/first-run.md): connect your AI, where projects live, ready. Each step can be
 * skipped; a skipped AI leaves a standing notice on Home (SetupCallout) that opens this flow again. The same
 * choice cards and their fields are used by Settings › AI, so there is one way to connect an AI anywhere.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { getApi } from '../api';
import { rkc } from '../hooks';
import { Button, ChoiceCard, IconButton, SetupStep, StatusDot, Text, TextField, applicableSteps, nextStepKey, prevStepKey, useToast } from '../kit';
import { useStore } from '../store/context';
import { agentChoices, setupSteps, setupSummary, type AgentChoice, type SetupStepKey } from '../store/setup';
import type { SetupInfo } from '../types';

const openUrl = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
};

/** A quiet link line ("Get a key at ppq.ai"). */
function LinkLine({ label, url }: { label: string; url: string }) {
  return (
    <Pressable onPress={() => openUrl(url)} accessibilityRole="link" accessibilityLabel={label} className={Platform.OS === 'web' ? 'cursor-pointer self-start' : 'self-start'}>
      <Text variant="caption" tone="primary-text">
        {label}
      </Text>
    </Pressable>
  );
}

/** The Claude login, as fields: log in (the browser opens; a code can be pasted), or who is logged in. */
export function ClaudeLoginBody({ setup }: { setup: SetupInfo }) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const login = state.claudeLogin;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>, fail: string) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast({ title: fail, description: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  if (setup.claude.loggedIn) {
    return (
      <View className="flex-row items-center gap-2">
        <StatusDot tone="success" size={8} />
        <Text variant="body-sm" className="min-w-0 flex-1" numberOfLines={1}>
          Logged in{setup.claude.email ? ` as ${setup.claude.email}` : ''}
          {setup.claude.plan ? ` · ${setup.claude.plan}` : ''}
        </Text>
        {setup.agent && setup.agent !== 'claude' ? <Button size="sm" variant="secondary" label="Use for new bots" onPress={() => void run(() => actions.saveSetup({ agent: 'claude' }), 'Could not save')} /> : null}
        <Button size="sm" variant="ghost" label="Log out" loading={busy} onPress={() => void run(async () => { await getApi().claudeLogout(); await actions.refreshSetup(); }, 'Could not log out')} />
      </View>
    );
  }
  if (login?.running) {
    return (
      <View className="gap-2.5">
        <View className="flex-row items-center gap-2">
          <StatusDot tone="primary" size={8} pulse />
          <Text variant="body-sm" className="min-w-0 flex-1">
            {login.waitingForCode ? 'Finish in the browser, then paste the code it shows.' : 'Finishing in your browser…'}
          </Text>
          <Button size="sm" variant="ghost" label="Cancel" onPress={() => void run(() => getApi().claudeLoginCancel(), 'Could not cancel')} />
        </View>
        {login.url ? <LinkLine label="Didn't open? Open the sign-in page" url={login.url} /> : null}
        {login.waitingForCode ? (
          <TextField
            mono
            size="sm"
            value={code}
            onChangeText={setCode}
            placeholder="Paste the code here"
            autoCapitalize="none"
            accessibilityLabel="Login code"
            onSubmitEditing={() => void run(() => getApi().claudeLoginCode({ code }), 'The code was not accepted')}
            trailing={<Button size="sm" variant="primary" label="Finish" disabled={!code.trim()} loading={busy} onPress={() => void run(() => getApi().claudeLoginCode({ code }), 'The code was not accepted')} />}
          />
        ) : null}
      </View>
    );
  }
  return (
    <View className="gap-2">
      {login?.error ? (
        <Text variant="caption" tone="danger">
          {login.error}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-2">
        <Button variant="primary" label={login?.error ? 'Try again' : 'Log in with Claude'} icon="robot" loading={busy} onPress={() => void run(() => getApi().claudeLogin(), 'Could not start the login')} />
        {setup.claude.available === false ? (
          <Text variant="caption" tone="subtle">
            Agents run on a computer, not here.
          </Text>
        ) : (
          <Text variant="caption" tone="subtle" className="min-w-0 flex-1">
            Your browser opens. Nothing is typed here but a code, if asked.
          </Text>
        )}
      </View>
    </View>
  );
}

/** One preset's fields: a key to paste (PPQ, OpenRouter) or a URL to confirm (llama.cpp); saving makes it the one new bots run on. */
export function PresetBody({ setup, choice }: { setup: SetupInfo; choice: AgentChoice }) {
  const { actions } = useStore();
  const { toast } = useToast();
  const preset = setup.presets[choice.key];
  const held = setup.providers.find((p) => p.name === choice.key || p.preset === choice.key);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(held?.baseUrl ?? preset?.baseUrl ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrl(held?.baseUrl ?? preset?.baseUrl ?? ''), [held?.baseUrl, preset?.baseUrl]);
  if (!preset) return null;
  const needsKey = preset.key === 'required';
  const save = async () => {
    setBusy(true);
    try {
      const body: { name: string; baseUrl: string; token?: string } = { name: choice.key, baseUrl: url.trim() || preset.baseUrl };
      if (key.trim()) body.token = key.trim();
      const p = await getApi().setProvider(body);
      await actions.saveSetup({ agent: choice.key });
      setKey('');
      toast({ title: p.ready ? `${preset.label} ready` : `${preset.label} saved, no key yet`, description: p.ready ? 'New bots run on it.' : 'Paste its key and save again.', tone: p.ready ? 'success' : undefined });
    } catch (e) {
      toast({ title: `Could not save ${preset.label}`, description: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2">
      {choice.state === 'ready' ? (
        <View className="flex-row items-center gap-2">
          <StatusDot tone="success" size={8} />
          <Text variant="body-sm" className="min-w-0 flex-1">
            {needsKey ? 'Key saved' : 'Set'}
            {choice.chosen ? ' · new bots run on it' : ''}
          </Text>
          {!choice.chosen ? <Button size="sm" variant="secondary" label="Use for new bots" loading={busy} onPress={() => void save()} /> : null}
        </View>
      ) : null}
      {needsKey ? (
        <TextField mono size="sm" password value={key} onChangeText={setKey} placeholder={choice.state === 'ready' ? 'Paste a new key to replace it' : 'Paste the API key'} autoCapitalize="none" accessibilityLabel={`${preset.label} API key`} onSubmitEditing={() => void save()} trailing={<Button size="sm" variant="primary" label="Save" disabled={!key.trim()} loading={busy} onPress={() => void save()} />} />
      ) : (
        <TextField mono size="sm" value={url} onChangeText={setUrl} placeholder={preset.baseUrl} autoCapitalize="none" accessibilityLabel={`${preset.label} server URL`} hint="Where llama-server answers. Start it with a model first; the port is 8080 unless you changed it." trailing={<Button size="sm" variant="primary" label={choice.state === 'ready' ? 'Save' : 'Use it'} disabled={!url.trim()} loading={busy} onPress={() => void save()} />} />
      )}
      {preset.keyUrl ? <LinkLine label={needsKey ? `Get a key at ${new URL(preset.keyUrl).host}` : 'How to run llama-server'} url={preset.keyUrl} /> : null}
      {needsKey ? (
        <Text variant="caption" tone="subtle">
          The key is kept on this computer and never shown again or sent to your other devices.
        </Text>
      ) : null}
    </View>
  );
}

/** The ways of connecting an AI, as choice cards; the selected one shows its fields. */
export function AgentChoices({ setup, selected, onSelect }: { setup: SetupInfo; selected: string | null; onSelect: (key: string) => void }) {
  const choices = agentChoices(setup);
  return (
    <View className="gap-2">
      {choices.map((c) => (
        <ChoiceCard key={c.key} icon={c.icon} title={c.title} description={c.description} tag={c.chosen ? 'in use' : c.tag} selected={selected === c.key} onPress={() => onSelect(c.key)}>
          {c.key === 'claude' ? <ClaudeLoginBody setup={setup} /> : <PresetBody setup={setup} choice={c} />}
        </ChoiceCard>
      ))}
    </View>
  );
}

export interface SetupFlowProps {
  /** Finished or skipped: the flow is marked done on the device and goes away. */
  onDone: () => void;
  /** Opened from Home later: a way to close without finishing. */
  onClose?: () => void;
  /** Start at this step (Home's "Where projects live" opens the folder step). */
  startAt?: SetupStepKey;
}

export function SetupFlow({ onDone, onClose, startAt }: SetupFlowProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const setup = state.setup;
  const steps = applicableSteps(setupSteps(setup ?? { canHost: true }));
  const [step, setStep] = useState<SetupStepKey>(startAt ?? 'agent');
  const [choice, setChoice] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (setup && !folder) setFolder(setup.workspace);
  }, [setup, folder]);
  useEffect(() => {
    if (setup && choice === null) {
      const inUse = agentChoices(setup).find((c) => c.chosen);
      if (inUse) setChoice(inUse.key);
    }
  }, [setup, choice]);

  // the desktop app asked for the name on a page of its own before the daemon existed (electron/first-run.html,
  // "Step 1 of 4"): it lands here with ?welcome=1, and the steps are counted after it
  const offset = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('welcome') === '1' ? 1 : 0;
  const index = Math.max(0, steps.findIndex((s) => s.key === step)) + offset;
  const total = steps.length + offset;
  const next = useCallback(() => {
    const n = nextStepKey(steps, step);
    if (n) setStep(n);
  }, [steps, step]);
  const back = prevStepKey(steps, step);
  const finish = useCallback(async () => {
    setBusy(true);
    try {
      await actions.saveSetup({ done: true });
      onDone();
    } catch (e) {
      toast({ title: 'Could not save', description: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }, [actions, onDone, toast]);

  if (!setup) return null;

  const closeButton = onClose ? (
    <View className="absolute right-3 top-3 z-10" style={{ top: 'calc(12px + env(safe-area-inset-top, 0px))' } as never}>
      <IconButton icon="close" size="sm" accessibilityLabel="Close setup" onPress={onClose} />
    </View>
  ) : null;

  if (step === 'agent') {
    if (!setup.canHost) {
      return (
        <View className="relative flex-1">
          {closeButton}
          <SetupStep step={index} steps={total} icon="robot" title="Your AI runs on a computer" lead="Agents and their project folders live on your Mac or PC. Install rKeyChat there, connect your AI in its first-run steps, and log this phone in from it: Settings › Devices on the computer shows the code." primary={{ label: 'Continue', onPress: next }} />
        </View>
      );
    }
    return (
      <View className="relative flex-1">
        {closeButton}
        <SetupStep
          step={index}
          steps={total}
          icon="robot"
          title="Connect your AI"
          lead="Every project is worked on by an agent. Pick where its model comes from; you can change this any time in Settings."
          primary={{ label: 'Continue', onPress: next, disabled: !setup.connected }}
          onSkip={next}
        >
          <AgentChoices setup={setup} selected={choice} onSelect={setChoice} />
        </SetupStep>
      </View>
    );
  }

  if (step === 'folder') {
    const picker = rkc()?.pickFolder;
    const save = async () => {
      setBusy(true);
      try {
        const w = folder.trim();
        if (w && w !== setup.workspace) await getApi().setWorkspace({ workspace: w });
        await actions.refreshSetup();
        next();
      } catch (e) {
        toast({ title: 'Could not save the folder', description: (e as Error).message, tone: 'danger' });
      } finally {
        setBusy(false);
      }
    };
    return (
      <View className="relative flex-1">
        {closeButton}
        <SetupStep step={index} steps={total} icon="folder" title="Where projects live" lead="Each project is a folder on this computer. New ones go here unless you pick another place when you make them." primary={{ label: 'Continue', onPress: () => void save(), disabled: !folder.trim(), loading: busy }} onSkip={next} onBack={back ? () => setStep(back) : undefined}>
          <TextField
            mono
            value={folder}
            onChangeText={setFolder}
            placeholder="~/rKeyChat"
            autoCapitalize="none"
            accessibilityLabel="Projects folder"
            onSubmitEditing={() => void save()}
            trailing={picker ? <Button size="sm" variant="secondary" label="Choose…" onPress={() => void picker().then((p) => { if (p) setFolder(p); })} /> : undefined}
            hint="An existing folder you already work in can also become a project: drop it on the sidebar."
          />
        </SetupStep>
      </View>
    );
  }

  return (
    <View className="relative flex-1">
      {closeButton}
      <SetupStep step={index} steps={total} icon="tick" title="Ready" lead={setup.canHost ? 'Start a project from a folder, or make a new one. Your agent listens in each.' : 'Your projects appear here once this phone is logged in from your computer.'} primary={{ label: 'Open rKeyChat', onPress: () => void finish(), loading: busy }} onBack={back ? () => setStep(back) : undefined}>
        <View className="gap-1 rounded-card border border-overlay/[0.07] bg-overlay/[0.04] p-3.5" accessibilityLabel="Setup summary">
          {setupSummary(setup).map((line, i) => (
            <Text key={line} variant={i === 0 ? 'body' : 'caption'} tone={i === 0 ? undefined : 'muted'}>
              {line}
            </Text>
          ))}
        </View>
      </SetupStep>
    </View>
  );
}
