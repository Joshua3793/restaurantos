import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fergies.os',
  appName: "Fergie's OS",
  // webDir is relative to this file; used as fallback if server.url is unreachable.
  webDir: '../out',
  server: {
    url: 'https://controlaos.vercel.app',
    cleartext: false,
    allowNavigation: ['controlaos.vercel.app'],
  },
}

export default config
