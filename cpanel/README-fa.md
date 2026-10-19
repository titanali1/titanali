# راه‌اندازی XsayaTrade روی cPanel

این بسته برای **cPanel دارای Node.js Application / CloudLinux Node.js Selector و Passenger** آماده شده است. میزبانی صرفاً PHP/Static کافی نیست: بک‌اند این پروژه Node.js است و به Node.js **نسخهٔ ۲۲ یا جدیدتر** نیاز دارد. قبل از ادامه بررسی کنید این نسخه در cPanel شما قابل انتخاب باشد.

## ۱) آماده‌سازی دامنه و HTTPS

در cPanel، دامنه را به هاست اضافه کنید و از بخش اطلاعات هاست، IP عمومی/مقصدی را که میزبان ارائه کرده پیدا کنید. اگر DNS دامنه روی Cloudflare است، رکورد `A` برای `@` را به همان IP و رکورد `CNAME` برای `www` را به دامنهٔ اصلی تنظیم کنید؛ IP را حدس نزنید. در آغاز رکورد را روی **DNS only** بگذارید تا گواهی SSL/AutoSSL در cPanel صادر شود. پس از فعال‌شدن HTTPS، اگر خواستید Cloudflare Proxy را روشن کنید، حالت SSL را روی **Full (strict)** بگذارید و مطمئن شوید گواهی معتبر سمت هاست وجود دارد.

## ۲) ساخت Node.js Application

1. در cPanel وارد **Setup Node.js App** یا **Application Manager** شوید و برنامهٔ تازه بسازید.
2. Node.js version را روی `22` یا بالاتر قرار دهید؛ Application mode را `Production` انتخاب کنید.
3. Application root را در مسیر خصوصی خارج از `public_html` بسازید؛ برای نمونه `xsayatrade-app`. مسیر Application URL را روی دامنهٔ اصلی در ریشه (`/`) قرار دهید، نه زیرپوشه.
4. Startup file را `server.js` بگذارید.
5. بستهٔ ZIP را در Application root بارگذاری و Extract کنید؛ سپس در صفحهٔ برنامه **Run NPM Install** را بزنید.
6. مقادیر بخش «متغیرهای محیطی» را در پنل Node.js App وارد کنید. فایل نمونه را با نام `.env` آپلود نکنید؛ برنامه در محیط Production آن را نمی‌خواند و Secretها باید در پنل بمانند.
7. برنامه را Restart کنید. cPanel/Passenger معمولاً فایل `.htaccess` و تنظیمات Passenger لازم را هنگام ساخت Application URL ایجاد می‌کند. آن فایل را از یک نمونهٔ دارای مسیرهای فرضی کپی نکنید.

اگر cPanel فایل Passenger را به‌صورت خودکار نساخت، از راهنمای همان شرکت هاست استفاده کنید. قالب مفهومی تنظیمات (مسیرها را از صفحهٔ Node.js App خودتان بردارید؛ این خطوط را عیناً کپی نکنید):

```apache
PassengerEnabled on
PassengerAppRoot /home/CPANEL_USER/xsayatrade-app
PassengerBaseURI /
PassengerNodejs /home/CPANEL_USER/nodevenv/xsayatrade-app/22/bin/node
PassengerAppType node
PassengerStartupFile server.js
```

## ۳) متغیرهای محیطی در پنل

برای دامنهٔ اصلی `xsayatrade.ir` و `www` این تنظیمات را اضافه کنید. اگر `www` را استفاده نمی‌کنید، آن را از هر سه فهرست دامنه حذف کنید.

```text
NODE_ENV=production
HOST=0.0.0.0
XSAYATRADE_ADMIN_USERNAME=<نام‌کاربری مدیر دلخواه>
XSAYATRADE_ADMIN_PASSWORD=<گذرواژهٔ تصادفی قوی و منحصربه‌فرد>
XSAYATRADE_MASTER_KEY=<خروجی openssl rand -hex 32؛ دقیقاً ۶۴ رقم hex>
XSAYATRADE_DATA_DIR=/home/CPANEL_USER/xsayatrade-private-data
XSAYATRADE_ALLOWED_HOSTS=xsayatrade.ir,www.xsayatrade.ir
XSAYATRADE_ALLOWED_ORIGINS=https://xsayatrade.ir,https://www.xsayatrade.ir
XSAYATRADE_MANAGEABLE_ORIGINS=https://xsayatrade.ir,https://www.xsayatrade.ir
XSAYATRADE_TRUST_PROXY=true
XSAYATRADE_ENABLE_EXCHANGE_CONNECTIONS=false
XSAYATRADE_LIVE_TRADING=false
XSAYATRADE_ALLOWED_EXCHANGES=binance,okx,kucoin,nobitex,wallex,bitpin
XSAYATRADE_ORDER_QUOTE_LIMITS={"USDT":100}
XSAYATRADE_MAX_LIMIT_DEVIATION_PERCENT=2
```

- `PORT` را خودتان تعیین نکنید؛ مقدار تخصیص‌یافته را cPanel/Passenger فراهم می‌کند.
- `XSAYATRADE_DATA_DIR` باید خارج از `public_html` و خارج از پوشهٔ قابل‌دانلود برنامه باشد. پوشه را برای کاربر cPanel قابل‌نوشتن و با مجوز `0700` نگه دارید.
- در cPanel Terminal می‌توانید کلید اصلی بسازید: `openssl rand -hex 32`. آن را امن پشتیبان‌گیری کنید؛ بدون همان کلید، Vault رمزگذاری‌شده قابل بازیابی نیست.
- بعد از اولین راه‌اندازی و ایجاد حساب مدیر، مقدار `XSAYATRADE_ADMIN_PASSWORD` را از متغیرهای برنامه پاک کنید. گذرواژهٔ مدیر را بعداً از پنل مدیریت اپ تغییر دهید.
- `XSAYATRADE_TRUST_PROXY=true` را فقط وقتی نگه دارید که برنامه فقط از پشت پراکسی مورداعتماد cPanel/Passenger قابل دسترسی باشد.
- اتصال صرافی و معاملهٔ واقعی در این نمونه خاموش می‌مانند. برای فعال‌سازی واقعی ابتدا پشتیبانی هر adapter، امنیت هاست، محدودیت منابع و الزامات صرافی را جداگانه بررسی کنید.

## ۴) بررسی راه‌اندازی

پس از Restart این نشانی‌ها را آزمایش کنید:

- `https://xsayatrade.ir/` برای رابط وب
- `https://xsayatrade.ir/api/health` برای سلامت API

اگر خطای `421 Host is not allowed` دریافت شد، Host فعلی باید دقیقاً در `XSAYATRADE_ALLOWED_HOSTS` و Origin دارای `https://` در `XSAYATRADE_ALLOWED_ORIGINS` باشد؛ متغیرها را در پنل اصلاح و برنامه را Restart کنید. اگر cPanel نسخهٔ Node 22+ یا Passenger app ندارد، این هاست برای اجرای بک‌اند این پروژه مناسب نیست و باید از هاست Node.js/VPS استفاده شود.

## ۵) اتصال اپ اندروید پس از انتشار وب

این ZIP فقط بک‌اند و رابط وب را دارد. پس از آن‌که دامنه با HTTPS بالا آمد، برای اینکه APK به همان سرور وصل شود، پروژهٔ اندروید را با آدرس HTTPS دامنه بسازید:

```bash
cd android
gradle --no-daemon :app:assembleDebug -PxsayatradeBackendUrl=https://xsayatrade.ir
```

برای انتشار عمومی، APK نوع Release نیازمند keystore خصوصی مالک است؛ keystore یا رمز امضای آن را در مخزن یا گفتگو قرار ندهید.

## ۶) به‌روزرسانی و پشتیبان‌گیری

هنگام انتشار نسخهٔ جدید، فایل‌های برنامه را در Application root به‌روزرسانی، `npm install` را اجرا و برنامه را Restart کنید. پوشهٔ داده و `XSAYATRADE_MASTER_KEY` را حذف یا عوض نکنید؛ از هر دو پشتیبان رمزگذاری‌شده و محدوددسترسی بگیرید. APK اندروید در این ZIP نیست؛ این بسته برای بک‌اند/وب روی cPanel است.
