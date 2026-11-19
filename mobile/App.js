// rKeyChat for iPhone/Android. The whole backend (pearcore, rooms, rKey keys)
// runs on this device in a Bare worklet; the UI is the same web UI as the
// desktop app, served by that backend on 127.0.0.1 and shown full screen.
import { useEffect, useRef, useState } from 'react'
import { AppState, Pressable, Share, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Clipboard from 'expo-clipboard'

// what the page sees as window.rkcMobile: copy and share through the app
const BRIDGE = `window.rkcMobile = {
  copy: (text) => { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text: String(text) })); return true },
  share: (text) => { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'share', text: String(text) })); return true }
}; true;`
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import { Paths } from 'expo-file-system'
import b4a from 'b4a'
import bundle from './app.bundle.mjs'

const NAME = 'guy' // how you appear to others from this device (see README)
const BG = '#09090b'

let worklet = null // one backend per app process, even if the component remounts

function startBackend (onEvent) {
  if (worklet) return worklet
  const docs = decodeURI(Paths.document.uri.replace(/^file:\/\//, '')).replace(/\/$/, '')
  worklet = new Worklet()
  worklet.start('/app.bundle', bundle, [docs, NAME])
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

export default function App () {
  const [url, setUrl] = useState(null)
  const [status, setStatus] = useState('Starting…')
  const [error, setError] = useState(null)
  const [strayed, setStrayed] = useState(false) // the page left the chat; offer a way back
  const web = useRef(null)

  useEffect(() => {
    startBackend((e) => {
      if (e.event === 'created') setStatus('Made your keys for this phone…')
      if (e.event === 'ready') setUrl(e.url)
      if (e.event === 'error') setError(e.message)
    })
    // let the backend pause and resume with the app
    const sub = AppState.addEventListener('change', (state) => Worklet.update(state))
    return () => sub.remove()
  }, [])

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
  escapeText: { color: '#ececf1', fontSize: 14, fontWeight: '600' }
})
