# Vexon

Vexon is a Persian/English trading-dashboard prototype with a native Android WebView shell, an installable PWA, and a security-focused Node.js backend foundation. A lightweight dictionary-driven i18n layer switches language, direction, and numeral style, and preserves the preference locally. The in-app design attribution is `dmj74`. It is **not production-ready for real-money trading** until the operator completes HTTPS deployment, reviews the selected exchange adapters and validates the deployment configuration.

## Run locally

```bash
cp .env.example .env
# Set a unique admin password and generate VEXON_MASTER_KEY with: openssl rand -hex 32
npm install
npm run dev
```

Open `http://localhost:8787`. Node.js 22 or newer is required. The default configuration keeps exchange connections and live trading disabled. Never commit `.env`, real credentials, or the encryption key.

## Security controls in the backend

- One fixed admin username with no public signup. On first run, bootstrap credentials come from the environment; only a salted scrypt password hash is persisted. The admin password can be changed in Management, after which all sessions are revoked. Login attempts are rate-limited, and sessions use short-lived HttpOnly, SameSite cookies with CSRF-token checks. Remove the bootstrap password from the environment after initializing the persistent admin account.
- Exchange API keys are verified server-side and encrypted at rest with AES-256-GCM. The 32-byte master key is environment-provided; the encrypted vault lives in `.vexon-data/` (permissions 0700/0600). Back it up securely with the matching key.
- No withdrawal endpoint exists. Create exchange keys with only read and spot-trading permissions, and explicitly disable withdrawals at the exchange.
- The signed-in administrator can lock individual app features and issue expiring, use-limited access codes from **Settings → Server & password management → Feature locks & access codes**. Code hashes are HMAC-stored server-side; the raw code is returned for display once. Anonymous feature unlocks receive a feature-scoped, signed HttpOnly cookie; lock changes and code revocations invalidate existing grants. Locked features prompt for a code and link to `https://t.me/dmj74`. Treat code delivery as a separate secure step.
- Live orders are **off by default**. If deliberately enabled, the backend accepts spot **limit** orders only, checks market availability, quote-currency caps, available balance, amount precision and limit-price deviation, applies a request rate limit, records an audit event, and reserves idempotency keys before sending. Market orders and automated trading are not enabled.
- The CCXT adapter checks capabilities and verifies credentials by reading balance before encrypting them. With the currently pinned CCXT release, Binance, OKX and KuCoin have compatible adapters; Nobitex, Wallex and Bitpin are reported unavailable and disabled in the UI. Do not enter Iranian-exchange credentials until their official adapters are implemented and reviewed.
- Production requires explicit allowed hosts/origins and a trusted HTTPS reverse proxy. Do not expose the Node process directly to the public internet. Keep `.vexon-data` on a protected persistent volume. A non-root Node 22 Docker image is provided; bind its port only to loopback behind TLS termination.

On first start, configure `VEXON_ADMIN_USERNAME` and a unique `VEXON_ADMIN_PASSWORD`; these bootstrap the fixed administrator account once. After confirming the account file exists in the persistent data volume, remove the bootstrap password from the environment. The Management screen supports password changes and server-origin selection. Domain choices must first be added to `VEXON_MANAGEABLE_ORIGINS`; selecting one changes the backend host/origin allowlist but does not create DNS records, TLS certificates, or reverse-proxy routes. Keep the Android `vexonBackendUrl` build setting aligned with the deployed domain.

Before enabling production connections, configure `VEXON_MASTER_KEY`, `VEXON_ALLOWED_HOSTS`, `VEXON_ALLOWED_ORIGINS`, `VEXON_DATA_DIR`, and `VEXON_ENABLE_EXCHANGE_CONNECTIONS`. Keep `VEXON_LIVE_TRADING=false` while validating each exchange in its sandbox or with read-only API keys. `VEXON_ORDER_QUOTE_LIMITS` is a JSON map of quote currency to maximum per-order notional (default: 100 USDT); set a conservative limit for every allowed quote currency before live use.

### Docker deployment outline

After creating a protected environment file outside the repository and provisioning HTTPS at a reverse proxy:

```bash
docker build -t vexon-backend .
docker run -d --name vexon --restart unless-stopped \
  --env-file /secure/path/vexon.env \
  -e VEXON_DATA_DIR=/data \
  -p 127.0.0.1:8787:8787 \
  --mount source=vexon-data,target=/data \
  vexon-backend
```

In the production env file set the exact public hostname and HTTPS origin. Keep connection and live-trading flags off until the deployment has been security-reviewed.

## Android APK

The Android Studio project is in `android/`. Open that folder and build `:app:assembleDebug` with JDK 17, Android SDK 35, and Gradle 8.11.1. To connect the APK to a deployed HTTPS backend, pass `-PvexonBackendUrl=https://trade.example.com` to Gradle; without it, the APK opens the bundled demo and backend routes remain unavailable. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The GitHub Actions workflow `.github/workflows/android-apk.yml` builds the APK artifact. The APK is a client shell; it does not bundle server credentials or enable real trading. If an uncaught Java crash occurs, the app stores a short diagnostic locally (device model, Android/WebView versions and stack trace); on the next launch it displays a copy button. No crash report is automatically sent. The `dmj74` mark is an in-app attribution, not an Android signing certificate; publishing a release APK requires the owner’s private keystore.
