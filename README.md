# XsayaTrade

XsayaTrade is a Persian/English trading-dashboard prototype with a native Android WebView shell, an installable PWA, and a security-focused Node.js backend foundation. A lightweight dictionary-driven i18n layer switches language, direction, and numeral style, and preserves the preference locally. The in-app design attribution is `dmj74`. It is **not production-ready for real-money trading** until the operator completes HTTPS deployment, reviews the selected exchange adapters and validates the deployment configuration.

## Run locally

```bash
cp .env.example .env
# Set a unique admin password and generate XSAYATRADE_MASTER_KEY with: openssl rand -hex 32
npm install
npm run dev
```

Open `http://localhost:8787`. Node.js 22 or newer is required. The default configuration keeps exchange connections and live trading disabled. Never commit `.env`, real credentials, or the encryption key.

## Security controls in the backend

- One fixed admin username with no public signup. On first run, bootstrap credentials come from the environment; only a salted scrypt password hash is persisted. The admin password can be changed in Management, after which all sessions are revoked. Login attempts are rate-limited, and sessions use short-lived HttpOnly, SameSite cookies with CSRF-token checks. Remove the bootstrap password from the environment after initializing the persistent admin account.
- Exchange API keys are verified server-side and encrypted at rest with AES-256-GCM. The 32-byte master key is environment-provided; the encrypted vault lives in `.xsayatrade-data/` (permissions 0700/0600). Back it up securely with the matching key.
- No withdrawal endpoint exists. Create exchange keys with only read and spot-trading permissions, and explicitly disable withdrawals at the exchange.
- The signed-in administrator can lock individual app features and issue expiring, use-limited access codes from **Settings → Server & password management → Feature locks & access codes**. Code hashes are HMAC-stored server-side; the raw code is returned for display once. Anonymous feature unlocks receive a feature-scoped, signed HttpOnly cookie; lock changes and code revocations invalidate existing grants. Locked features prompt for a code and link to `https://t.me/dmj74`. Treat code delivery as a separate secure step.
- Live orders are **off by default**. If deliberately enabled, the backend accepts spot **limit** orders only, checks market availability, quote-currency caps, available balance, amount precision and limit-price deviation, applies a request rate limit, records an audit event, and reserves idempotency keys before sending. Market orders and automated trading are not enabled.
- The CCXT adapter checks capabilities and verifies credentials by reading balance before encrypting them. With the currently pinned CCXT release, Binance, OKX and KuCoin have compatible adapters; Nobitex, Wallex and Bitpin are reported unavailable and disabled in the UI. Do not enter Iranian-exchange credentials until their official adapters are implemented and reviewed.
- Production requires explicit allowed hosts/origins and a trusted HTTPS reverse proxy. Do not expose the Node process directly to the public internet. Keep `.xsayatrade-data` on a protected persistent volume. A non-root Node 22 Docker image is provided; bind its port only to loopback behind TLS termination.

On first start, configure `XSAYATRADE_ADMIN_USERNAME` and a unique `XSAYATRADE_ADMIN_PASSWORD`; these bootstrap the fixed administrator account once. After confirming the account file exists in the persistent data volume, remove the bootstrap password from the environment. The Management screen supports password changes and server-origin selection. Domain choices must first be added to `XSAYATRADE_MANAGEABLE_ORIGINS`; selecting one changes the backend host/origin allowlist but does not create DNS records, TLS certificates, or reverse-proxy routes. Keep the Android `xsayatradeBackendUrl` build setting aligned with the deployed domain.

Before enabling production connections, configure `XSAYATRADE_MASTER_KEY`, `XSAYATRADE_ALLOWED_HOSTS`, `XSAYATRADE_ALLOWED_ORIGINS`, `XSAYATRADE_DATA_DIR`, and `XSAYATRADE_ENABLE_EXCHANGE_CONNECTIONS`. Keep `XSAYATRADE_LIVE_TRADING=false` while validating each exchange in its sandbox or with read-only API keys. `XSAYATRADE_ORDER_QUOTE_LIMITS` is a JSON map of quote currency to maximum per-order notional (default: 100 USDT); set a conservative limit for every allowed quote currency before live use.

### Docker deployment outline

After creating a protected environment file outside the repository and provisioning HTTPS at a reverse proxy, keep the existing Docker volume name if it already contains encrypted credentials:

```bash
docker build -t xsayatrade-backend .
docker run -d --name xsayatrade --restart unless-stopped \
  --env-file /secure/path/xsayatrade.env \
  -e XSAYATRADE_DATA_DIR=/data \
  -p 127.0.0.1:8787:8787 \
  --mount source=vexon-data,target=/data \
  xsayatrade-backend
```

In the production env file set the exact public hostname and HTTPS origin. Keep connection and live-trading flags off until the deployment has been security-reviewed.

## NOVA AI Studio Android app

The Android launcher opens a Persian-first, mobile-friendly AI creation studio with three interactive workflows: long-form video planning from text and optional reference images (5–60 minute project lengths with editable scene/storyboard cards), image creation controls, and audio creation modes for narration, music, and sound effects. The UI includes local image preview/file selection and a sample project library. Its current generation controls are explicitly **demo-only**; no video, image, or audio model is connected, and sample outputs are illustrative placeholders. Real generation requires choosing providers and deploying server-side adapters, secure secret storage, file upload handling, job queues, and persistent output storage. Never place model API keys in the Android app or browser.

The Android APK defaults to the bundled `ai-studio.html` experience. The studio is also available at `/ai-studio.html` when the Node server is deployed. The trading dashboard remains at `/` as a separate web route. Configure the optional `xsayatradeBackendUrl` Gradle property only after that host serves the studio route over HTTPS.

## Android APK

The Android Studio project is in `android/` (Gradle project name `XsayaTrade`). Open that folder and build `:app:assembleDebug` with JDK 17, Android SDK 35, and Gradle 8.11.1. Android `minSdk` is 21 (Android 5.0); this is a broad compatibility target, not a guarantee for every device or vendor WebView. The new application ID is `ai.xsayatrade.app`. It is intentionally different from the old `ai.vexon.app`; Android treats it as a fresh app, so remove the old app from the device before or after installing this build. The Android launcher is named NOVA AI Studio and opens the bundled AI-creation interface; its application ID remains `ai.xsayatrade.app`. To load a deployed HTTPS host, pass `-PxsayatradeBackendUrl=https://trade.example.com` to Gradle; the host must serve `/ai-studio.html`. Without it, the APK opens the bundled AI Studio UI, but AI generation is only a UI prototype and no model backend is configured. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The GitHub Actions workflow `.github/workflows/android-apk.yml` builds the APK artifact. The APK is a client shell; it does not bundle server credentials or enable real trading. If an uncaught Java crash occurs, the app stores a short diagnostic locally (device model, Android/WebView versions and stack trace); on the next launch it displays a copy button. No crash report is automatically sent. Android emulator smoke tests and physical-device/vendor-WebView coverage are not currently available in CI, so test the generated APK on your target devices before distribution. The `dmj74` mark is an in-app attribution, not an Android signing certificate; publishing a release APK requires the owner’s private keystore.


Branding note: the Android namespace/application ID, app label, web/PWA, backend package, configuration names, cookies, and data directory now use XsayaTrade. Rename existing backend environment keys from `VEXON_*` to `XSAYATRADE_*` when deploying this version, keeping the existing master-key value exactly unchanged so the encrypted credential vault remains readable. On a local install, if `.vexon-data` exists and `.xsayatrade-data` does not, startup moves the data directory in place so the encrypted vault and administrator record are retained. Existing Android app installs cannot be deleted remotely by this repository; uninstall `ai.vexon.app` (and, if present, `ai.vexon.app.debug`) manually from Android Settings or with ADB before installing the new package. With ADB, run `adb uninstall ai.vexon.app` and, if the debug build is installed, `adb uninstall ai.vexon.app.debug`. Removing the old app deletes its local app data.
