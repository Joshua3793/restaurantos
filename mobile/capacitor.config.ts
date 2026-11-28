import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fergies.os',
  appName: "Fergie's OS",
  // Bundled into the app. The live site is loaded from server.url; these local
  // files are only the loader (index.html) and the offline page (error.html).
  webDir: 'www',
  server: {
    url: 'https://controlaos.app',
    cleartext: false,
    // Keep the old Vercel host so existing sessions and saved links still open in-app.
    allowNavigation: ['controlaos.app', 'www.controlaos.app', 'controlaos.vercel.app'],
    // Shown when the live site can't load (no signal). Relative to webDir.
    errorPath: 'error.html',
  },
  plugins: {
    LocalNotifications: {
      // Android only. Must be an existing res/drawable resource.
      smallIcon: 'ic_launcher_foreground',
      iconColor: '#d97706',
    },
    // Read by @capacitor/status-bar 6+. On 5.x the plugin ignores config, so the
    // same values are applied natively: iOS via UIStatusBarStyle in Info.plist,
    // Android via the default (non-overlaying) status bar. Web code may also call
    // StatusBar.setStyle({ style: Style.Light }) / setOverlaysWebView({ overlay: false }).
    StatusBar: {
      style: 'LIGHT', // dark text for the white top bar
      overlaysWebView: false,
      backgroundColor: '#ffffff',
    },
  },
}

export default config
