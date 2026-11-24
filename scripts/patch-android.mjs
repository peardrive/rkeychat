// The Android project is generated (`npx expo prebuild --platform android`, mobile/android is gitignored like ios/).
// What the generated gradle files lack is put in here, idempotently, so a fresh prebuild gets the same build:
//   1. release signing from a properties file OUTSIDE the tree (~/Anjou/_keys/rkeychat-android-keystore.properties,
//      or -PkeystorePropertiesPath=…); without it the release APK is debug-signed, and gradle says so
//   2. the Bare libraries ask for AGP `+` from mavenCentral only: force the app's AGP and add google()
//   3. 4 GB for gradle: the bare-kit .so is large (PearDrop OOMed at 2 GB)
// Run by scripts/deliver-apk.sh; `node scripts/patch-android.mjs` by hand after a prebuild.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const android = path.join(here, '..', 'mobile', 'android')
if (!fs.existsSync(android)) { console.error('no mobile/android: run `npx expo prebuild --platform android --no-install` in mobile/ first'); process.exit(1) }
const edit = (rel, fn) => {
  const p = path.join(android, rel)
  const before = fs.readFileSync(p, 'utf8')
  const after = fn(before)
  if (after !== before) { fs.writeFileSync(p, after); console.log('patched', rel) } else console.log('ok     ', rel)
}
const agp = (() => {
  try {
    const toml = fs.readFileSync(path.join(here, '..', 'mobile', 'node_modules', '@react-native', 'gradle-plugin', 'gradle', 'libs.versions.toml'), 'utf8')
    return toml.match(/^agp\s*=\s*"([^"]+)"/m)?.[1]
  } catch { return null }
})() ?? '8.12.0'

edit('app/build.gradle', (s) => {
  if (!s.includes('hasReleaseKeystore')) {
    s = s.replace(/\nandroid \{\n    ndkVersion/, `
/**
 * Release signing (2026-11-24, as PearDrop does it; put here by scripts/patch-android.mjs): a properties file OUTSIDE
 * the tree (storeFile, storePassword, keyAlias, keyPassword), named by -PkeystorePropertiesPath or found at
 * ~/Anjou/_keys/rkeychat-android-keystore.properties. Without it a release build is DEBUG-SIGNED: fine to sideload,
 * but it cannot be published and a later signed build cannot update it. scripts/deliver-apk.sh says which it made.
 */
def keystorePropertiesPathOverride = findProperty('keystorePropertiesPath')
def keystorePropertiesFile = keystorePropertiesPathOverride
    ? file(keystorePropertiesPathOverride.toString())
    : new File(System.getProperty('user.home'), 'Anjou/_keys/rkeychat-android-keystore.properties')
def keystoreProperties = new Properties()
def hasReleaseKeystore = false
def releaseStoreFile = null
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.withInputStream { keystoreProperties.load(it) }
    def declaredStore = keystoreProperties['storeFile']
    if (declaredStore) {
        def declared = new File(declaredStore.toString())
        releaseStoreFile = declared.isAbsolute() ? declared : new File(keystorePropertiesFile.parentFile, declaredStore.toString())
        if (!releaseStoreFile.exists()) releaseStoreFile = null
    }
    hasReleaseKeystore = declaredStore && keystoreProperties['storePassword'] && keystoreProperties['keyAlias'] && keystoreProperties['keyPassword'] && releaseStoreFile != null
}
if (!hasReleaseKeystore) {
    logger.lifecycle("WARNING: no usable keystore properties - release builds will be DEBUG-SIGNED. They cannot be published, and a signed build cannot update them.")
}

android {
    ndkVersion`)
    s = s.replace(/(        debug \{\n            storeFile file\('debug\.keystore'\)[\s\S]*?\n        \}\n)(    \})/, `$1        if (hasReleaseKeystore) {
            release {
                storeFile releaseStoreFile
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
$2`)
    s = s.replace(/            \/\/ Caution! In production, you need to generate your own keystore file\.\n            \/\/ see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\n            signingConfig signingConfigs\.debug/, '            signingConfig hasReleaseKeystore ? signingConfigs.release : signingConfigs.debug')
    if (!s.includes('hasReleaseKeystore ? signingConfigs.release')) throw new Error('app/build.gradle: the release signingConfig line was not where expected')
  }
  return s
})

edit('build.gradle', (s) => {
  if (s.includes('resolutionStrategy.force')) return s
  return s.replace(/\nallprojects \{\n  repositories \{/, `
// react-native-b4a, -bare-kit and -fs ask for AGP \`+\` from mavenCentral only: force the app's AGP (the version
// @react-native/gradle-plugin pins), and add google() because AGP is not on mavenCentral (PearDrop, 2026-11).
subprojects {
  buildscript {
    repositories {
      google()
      mavenCentral()
    }
  }
  buildscript.configurations.matching { it.name == 'classpath' }.configureEach {
    resolutionStrategy.force 'com.android.tools.build:gradle:${agp}'
  }
}

allprojects {
  repositories {`)
})

edit('gradle.properties', (s) => {
  s = s.replace('org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m', 'org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m')
  // react-native-bare-kit declares minSdk 29; Expo's template reads this property for the app's minSdk (default 24)
  if (!/^android\.minSdkVersion=/m.test(s)) s += '\n# the Bare engine (react-native-bare-kit) needs Android 10 or newer\nandroid.minSdkVersion=29\n'
  return s
})

// 4. Expo's wrapper gives the Gradle download ten seconds; services.gradle.org is sometimes slower than that from here
edit('gradle/wrapper/gradle-wrapper.properties', (s) => s.replace(/networkTimeout=\d+/, 'networkTimeout=120000'))
