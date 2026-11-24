// rKeyChat for iPhone/Android. The whole backend (pearcore, rooms, rKey keys)
// runs on this device in a Bare worklet; the UI is the same web UI as the
// desktop app, served by that backend on 127.0.0.1 and shown full screen.
import { useEffect, useRef, useState } from 'react'
import { AppState, KeyboardAvoidingView, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Clipboard from 'expo-clipboard'

// what the page sees as window.rkcMobile: copy and share through the app
const BRIDGE = `window.rkcMobile = {
  copy: (text) => { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text: String(text) })); return true },
  share: (text) => { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'share', text: String(text) })); return true }
}; true;`
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import { File, Paths } from 'expo-file-system'
import b4a from 'b4a'
import bundle from './app.bundle.mjs'

const BG = '#09090b'
const docsDir = () => decodeURI(Paths.document.uri.replace(/^file:\/\//, '')).replace(/\/$/, '')
// The first run asks for a name before the engine starts (2026-11-24: until then the name was built in as 'guy').
// The engine makes this device's config with it; from then on the config is there and nothing is asked.
const hasConfig = () => { try { return new File(Paths.document, 'rkeychat', 'config.json').exists } catch { return false } }
const cleanName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
const NAME_OK = /^[a-z0-9][a-z0-9_-]{0,31}$/

let worklet = null // one backend per app process, even if the component remounts

function startBackend (name, onEvent) {
  if (worklet) return worklet
  const docs = docsDir()
  worklet = new Worklet()
  worklet.start('/app.bundle', bundle, [docs, name])
  let buf = ''
  worklet.IPC.on('data', (data) => {
    buf += b4a.toString(data)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try { onEvent(JSON.parse(line)) } catch {}
    }
  })
  return worklet
}

// Step 1 of 2 on a phone: the name messages carry. Drawn like the shell's own setup steps (PearKit SetupStep).
function NameScreen ({ onDone }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const submit = () => {
    const n = cleanName(name)
    if (!NAME_OK.test(n)) return setErr('Start with a letter or digit; lowercase letters, digits, - and _ only.')
    onDone(n)
  }
  return (
    <KeyboardAvoidingView style={styles.setup} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.setupBody}>
        <View style={styles.dots}><View style={[styles.dot, styles.dotOn]} /><View style={styles.dot} /><Text style={styles.dotsText}>Step 1 of 2</Text></View>
        <Text style={styles.h1}>Welcome to rKeyChat</Text>
        <Text style={styles.lead}>Projects, each with its own agent, between you and the people you work with. First: the name your messages carry.</Text>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={(t) => { setName(t); setErr('') }}
          placeholder='e.g. ben'
          placeholderTextColor='#6f7482'
          autoCapitalize='none'
          autoCorrect={false}
          autoFocus
          maxLength={32}
          returnKeyType='go'
          onSubmitEditing={submit}
          accessibilityLabel='Your name'
        />
        <Text style={styles.hint}>Lowercase letters, digits, - and _. Others see it as @name.</Text>
        {err ? <Text style={styles.err}>{err}</Text> : null}
        <View style={styles.foot}>
          <Pressable style={[styles.primary, !name.trim() && styles.primaryOff]} disabled={!name.trim()} onPress={submit} accessibilityRole='button' accessibilityLabel='Continue'>
            <Text style={styles.primaryText}>Continue  ›</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

export default function App () {
  const [url, setUrl] = useState(null)
  const [status, setStatus] = useState('Starting…')
  const [error, setError] = useState(null)
  const [strayed, setStrayed] = useState(false) // the page left the chat; offer a way back
  const [name, setName] = useState(() => (hasConfig() ? 'me' : null)) // the config holds the real name once it exists
  const web = useRef(null)

  useEffect(() => {
    if (!name) return
    startBackend(name, (e) => {
      if (e.event === 'created') setStatus('Made your keys for this phone…')
      if (e.event === 'ready') setUrl(e.url)
      if (e.event === 'error') setError(e.message)
    })
    // let the backend pause and resume with the app
    const sub = AppState.addEventListener('change', (state) => Worklet.update(state))
    return () => sub.remove()
  }, [name])

  if (!name) return <View style={styles.root}><StatusBar style='light' /><NameScreen onDone={setName} /></View>

  return (
    <View style={styles.root}>
      <StatusBar style='light' />
      {url
        ? (
          <WebView
            ref={web}
            source={{ uri: url }}
            style={styles.root}
            originWhitelist={['http://127.0.0.1*']}
            contentInsetAdjustmentBehavior='never'
            automaticallyAdjustContentInsets={false}
            hideKeyboardAccessoryView
            keyboardDisplayRequiresUserAction={false}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            mediaCapturePermissionGrantType='grant'
            allowsBackForwardNavigationGestures={false}
            bounces={false}
            onContentProcessDidTerminate={() => web.current?.reload()}
            // The chat page is the app. Nothing may replace it: a file link, a download,
            // an external URL. Those are handled inside the page (or not at all) so there is
            // never a screen without a way back.
            onShouldStartLoadWithRequest={(req) => {
              if (!req.isTopFrame) return true
              return isChatPage(req.url, url)
            }}
            onNavigationStateChange={(nav) => setStrayed(!nav.loading && !isChatPage(nav.url, url))}
            onError={() => setStrayed(true)}
            // The page runs over plain http on 127.0.0.1, where WebKit gives it no clipboard. The page asks the
            // app instead: window.rkcMobile.copy(text) → a message here → the phone's clipboard. Same for the
            // share sheet.
            injectedJavaScriptBeforeContentLoaded={BRIDGE}
            onMessage={(e) => {
              let m
              try { m = JSON.parse(e.nativeEvent.data) } catch { return }
              if (m?.type === 'copy' && typeof m.text === 'string') Clipboard.setStringAsync(m.text).catch(() => {})
              if (m?.type === 'share' && typeof m.text === 'string') Share.share({ message: m.text }).catch(() => {})
            }}
          />
          )
        : (
          <View style={styles.boot}>
            <Text style={styles.word}>rkeychat</Text>
            <Text style={styles.status}>{error ? 'Something went wrong starting up' : status}</Text>
            {error ? <Text style={styles.err} selectable>{error}</Text> : null}
          </View>
          )}
      {strayed && url
        ? (
          <Pressable style={styles.escape} onPress={() => { setStrayed(false); web.current?.injectJavaScript(`location.replace(${JSON.stringify(url)}); true`) }}>
            <Text style={styles.escapeText}>✕  back to chat</Text>
          </Pressable>
          )
        : null}
    </View>
  )
}

// Same origin, and the path is the page itself (the hash can be anything).
function isChatPage (candidate, home) {
  try {
    const a = new URL(candidate); const b = new URL(home)
    // the room page at /, or the projects shell under /app/ (it routes inside that prefix)
    const shell = b.pathname.startsWith('/app')
    return a.origin === b.origin && (a.pathname === '/' || a.pathname === b.pathname || (shell && a.pathname.startsWith('/app'))) && !a.search.includes('dl=1')
  } catch { return false }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: BG },
  word: { color: '#ececf1', fontSize: 22, fontWeight: '600', letterSpacing: 0.5, marginBottom: 10 },
  status: { color: '#8b8d98', fontSize: 14 },
  err: { color: '#f07a7a', fontSize: 11, marginTop: 16, fontFamily: 'Menlo' },
  escape: { position: 'absolute', top: 54, right: 16, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: 'rgba(24,24,28,0.92)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  escapeText: { color: '#ececf1', fontSize: 14, fontWeight: '600' },
  setup: { flex: 1, justifyContent: 'center', backgroundColor: BG },
  setupBody: { paddingHorizontal: 24, gap: 10 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  dot: { height: 6, width: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)' },
  dotOn: { width: 20, backgroundColor: '#b7e03c' },
  dotsText: { color: '#8b8d98', fontSize: 12, marginLeft: 4 },
  h1: { color: '#ececf1', fontSize: 24, fontWeight: '700' },
  lead: { color: '#a2a7b3', fontSize: 15, lineHeight: 21, marginBottom: 10 },
  label: { color: '#a2a7b3', fontSize: 13, fontWeight: '500' },
  input: { color: '#ececf1', fontSize: 17, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11 },
  hint: { color: '#6f7482', fontSize: 12.5 },
  err: { color: '#ff7a7a', fontSize: 12.5 },
  foot: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 },
  primary: { backgroundColor: '#b7e03c', borderRadius: 10, paddingHorizontal: 16, height: 40, justifyContent: 'center' },
  primaryOff: { opacity: 0.5 },
  primaryText: { color: '#141608', fontSize: 15, fontWeight: '600' }
})
