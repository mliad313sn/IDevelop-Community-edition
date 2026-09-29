import { CapacitorConfig } from '@capacitor/cli';

// The app id is the PUBLISHER's reverse-DNS namespace. Store listings key on
// it, so it must be STABLE. If you publish your own build (a fork, or your
// organisation's branded shell) set APP_ID to a namespace YOU own.
const APP_ID = process.env.APP_ID || 'org.idevelop.community';

// The displayed name is branding, so it is configurable like every other brand
// string.
const APP_NAME = process.env.APP_NAME || 'IDevelop';

// The deployment host is per-customer and therefore MUST come from the
// environment. There is no sensible default: a hard-coded host is either wrong
// for every deployment but one, or leaks whichever customer it was written for.
// Missing SERVER_URL fails loudly at build time rather than silently shipping a
// binary that points somewhere unintended.
const serverUrl = process.env.SERVER_URL;
if (!serverUrl) {
    throw new Error(
        'SERVER_URL is required to build the mobile shell. Set it to the ' +
        'deployment origin, e.g. SERVER_URL=https://app.example.com'
    );
}

// Navigation is restricted to the configured origin's host. Deriving it keeps
// the allow-list and the endpoint from drifting apart, and means no customer
// hostname is ever written into this file.
const serverHost = new URL(serverUrl).host;

const config: CapacitorConfig = {
    appId: APP_ID,
    appName: APP_NAME,
    webDir: '../public',
    bundledWebRuntime: false,
    server: {
        url: serverUrl,
        cleartext: false,
        allowNavigation: [serverHost],
    },
    android: { allowMixedContent: false },
    ios: { contentInset: 'always' },
};

export default config;
