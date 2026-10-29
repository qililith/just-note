import type { CapacitorConfig } from '@capacitor/cli'

/** Debug 跟站：设 JUST_NOTE_LIVE_URL（默认见 scripts）时 WebView 直接加载该站，免每次重打 APK。发版包勿带此变量。 */
const liveUrl = process.env.JUST_NOTE_LIVE_URL?.trim()

const config: CapacitorConfig = {
  appId: 'com.justnote',
  appName: 'Just Note',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    ...(liveUrl ? { url: liveUrl } : {})
  },
  android: {
    allowMixedContent: false
  },
  plugins: {
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true
    },
    StatusBar: {
      style: 'DEFAULT'
    }
  }
}

export default config
