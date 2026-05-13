import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fergies.os',
  appName: "Fergie's OS",
  // webDir is relative to this file; used as fallback if server.url is unreachable.
  webDir: '../out',
  server: {
    // Replace with your actual production Vercel URL before running cap sync.
    url: 'https://controlaos.vercel.app',
    cleartext: false,
  },
}

export default config
