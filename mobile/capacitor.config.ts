import { CapacitorConfig } from '@capacitor/cli';

// The app id is the PUBLISHER's reverse-DNS namespace. Store listings key on
// it, so it must be STABLE. If you publish your own build (a fork, or your
// organisation's branded shell) set APP_ID to a namespace YOU own.
const APP_ID = process.env.APP_ID || 'org.idevelop.community';

// The displayed name is branding, so it is configurable like every other brand
// string.
const APP_NAME = process.env.APP_NAME || 'IDevelop';

// Every security-relevant value comes from ONE gate, scripts/check-server-url.js,
// which throws (the build fails) unless SERVER_URL is https:// (http://localhost
// only with MOBILE_BUILD=dev) and the generated native projects, if any, keep
// Android allowBackup="false", no cleartext, not debuggable, and iOS App
// Transport Security on. The deployment host is per-organisation, so there is
// no default. The gate also derives: cleartext off, mixed content off,
// navigation limited to the configured host (the identity provider opens in
// the system browser), WebView debugging only in a development build.
// A build is a release build unless MOBILE_BUILD=dev is set.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildMobileSecurity } = require('./scripts/check-server-url');
const sec = buildMobileSecurity(process.env);

const config: CapacitorConfig = {
    appId: APP_ID,
    appName: APP_NAME,
    webDir: '../public',
    bundledWebRuntime: false,
    loggingBehavior: sec.release ? 'none' : 'debug',
    server: sec.server,
    android: { ...sec.android },
    ios: { contentInset: 'always', ...sec.ios },
};

export default config;
