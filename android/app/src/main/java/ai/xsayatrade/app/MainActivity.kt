package ai.xsayatrade.app

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import java.io.ByteArrayInputStream

class MainActivity : Activity() {
    private var webView: WebView? = null
    private lateinit var assetLoader: WebViewAssetLoader
    private var backendHost: String? = null
    private var rendererRestartAttempted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        installCrashReporter()
        super.onCreate(savedInstanceState)
        try {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            window.statusBarColor = Color.rgb(11, 16, 24)
            window.navigationBarColor = Color.rgb(11, 16, 24)
            window.decorView.systemUiVisibility = 0
            val previousCrash = readPreviousCrash()
            if (previousCrash != null) {
                showFallback("گزارش توقف قبلی ذخیره شد", previousCrash, allowRetry = true)
                return
            }
            safelyOpenApp(savedInstanceState)
        } catch (failure: RuntimeException) {
            showStartupError(failure)
        } catch (failure: LinkageError) {
            showStartupError(failure)
        }
    }

    private fun installCrashReporter() {
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, failure ->
            try {
                val report = buildCrashReport(thread, failure)
                openFileOutput("xsayatrade-last-crash.txt", MODE_PRIVATE).use { it.write(report.toByteArray(Charsets.UTF_8)) }
            } catch (_: Throwable) {
                // Preserve the platform's crash handling if local diagnostics cannot be written.
            }
            if (previousHandler != null) {
                previousHandler.uncaughtException(thread, failure)
            } else {
                android.os.Process.killProcess(android.os.Process.myPid())
                kotlin.system.exitProcess(10)
            }
        }
    }

    private fun buildCrashReport(thread: Thread, failure: Throwable): String = buildString {
        appendLine("XsayaTrade startup/runtime crash report")
        appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
        appendLine("Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        appendLine("Thread: ${thread.name}")
        appendLine("WebView: ${webViewProviderVersion()}")
        appendLine("Exception: ${failure.javaClass.name}: ${failure.message}")
        appendLine(android.util.Log.getStackTraceString(failure).take(12000))
    }

    private fun readPreviousCrash(): String? = try {
        openFileInput("xsayatrade-last-crash.txt").bufferedReader(Charsets.UTF_8).use { it.readText().take(12000) }
    } catch (_: Exception) {
        null
    }

    private fun clearPreviousCrash() {
        try { deleteFile("xsayatrade-last-crash.txt") } catch (_: Exception) { }
    }

    private fun webViewProviderVersion(): String = try {
        val provider = WebViewCompat.getCurrentWebViewPackage(this)
        if (provider == null) "unavailable" else "${provider.packageName} ${provider.versionName}"
    } catch (failure: Throwable) {
        "unavailable (${failure.javaClass.simpleName})"
    }

    private fun safelyOpenApp(savedInstanceState: Bundle?) {
        try {
            attachWebView(savedInstanceState)
        } catch (failure: RuntimeException) {
            showStartupError(failure)
        } catch (failure: LinkageError) {
            // Some vendor WebView packages omit or mismatch optional platform APIs.
            showStartupError(failure)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachWebView(savedInstanceState: Bundle?) {
        if (!::assetLoader.isInitialized) {
            assetLoader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
                .build()
        }
        val view = WebView(this).apply {
            setBackgroundColor(Color.rgb(11, 16, 24))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            // Use AndroidX feature detection so OEM WebView providers without safe browsing remain compatible.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING)) {
                WebSettingsCompat.setSafeBrowsingEnabled(settings, true)
            }
            webChromeClient = WebChromeClient()
            webViewClient = createWebViewClient()
        }
        webView?.let { previous ->
            (previous.parent as? ViewGroup)?.removeView(previous)
            previous.stopLoading()
            previous.destroy()
        }
        webView = view
        setContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        if (savedInstanceState != null) {
            view.restoreState(savedInstanceState)
        }
        if (view.url.isNullOrBlank()) loadAppUrl()
    }

    private fun createWebViewClient() = object : WebViewClientCompat() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/api/") == true) {
                val body = "{\"message\":\"Secure trading backend is not configured\"}".toByteArray()
                return WebResourceResponse(
                    "application/json", "UTF-8", 503, "Service Unavailable",
                    mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(body)
                )
            }
            return assetLoader.shouldInterceptRequest(uri)
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.scheme == "https" && uri.host in setOf("t.me", "telegram.me")) {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (_: Exception) {
                    // Stay in-app if no browser or Telegram client can open the link.
                }
                return true
            }
            val isBundled = uri.host == "appassets.androidplatform.net" && uri.scheme == "https"
            val isConfiguredBackend = backendHost != null && uri.host == backendHost && uri.scheme == "https"
            return !isBundled && !isConfiguredBackend
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            super.onReceivedError(view, request, error)
            if (request.isForMainFrame && view === webView) {
                showLoadError(error.errorCode)
            }
        }

        @TargetApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val wasMainView = view === webView
            (view.parent as? ViewGroup)?.removeView(view)
            view.stopLoading()
            view.destroy()
            if (!wasMainView) return true
            webView = null

            if (!rendererRestartAttempted) {
                rendererRestartAttempted = true
                safelyOpenApp(null)
            } else {
                showFallback(
                    "نمایشگر وب متوقف شد",
                    "WebView renderer exited (crashed=${detail.didCrash()}). Android System WebView یا Chrome را به‌روز کنید و دوباره تلاش کنید.",
                    allowRetry = true
                )
            }
            return true
        }
    }

    private fun loadAppUrl() {
        val currentWebView = webView ?: return
        val configuredBackend = BuildConfig.XSAYATRADE_BACKEND_URL.trim().trimEnd('/')
        if (configuredBackend.isNotEmpty()) {
            val uri = try { Uri.parse(configuredBackend) } catch (_: Exception) { null }
            if (uri == null || uri.scheme != "https" || uri.host.isNullOrBlank()) {
                showFallback("تنظیم سرور معتبر نیست", "آدرس بک‌اند باید یک نشانی HTTPS معتبر باشد.")
                return
            }
            backendHost = uri.host
            currentWebView.loadUrl("$configuredBackend/?native=1")
        } else {
            currentWebView.loadUrl("https://appassets.androidplatform.net/assets/index.html?native=1")
        }
    }

    private fun showStartupError(error: Throwable) {
        android.util.Log.e("XsayaTrade", "App startup failed", error)
        showFallback(
            "برنامه نتوانست شروع شود",
            "خطای سازگاری: ${error.javaClass.name}: ${error.message ?: "بدون توضیح"}\n\nAndroid System WebView یا Chrome را به‌روز کنید و دوباره تلاش کنید."
        )
    }

    private fun showLoadError(errorCode: Int) {
        showFallback(
            "صفحهٔ برنامه بارگذاری نشد",
            "خطای بارگذاری $errorCode. اتصال یا WebView دستگاه را بررسی کنید و دوباره تلاش کنید."
        )
    }

    private fun showFallback(title: String, detail: String, allowRetry: Boolean = true) {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            setPadding(24, 24, 24, 24)
            setBackgroundColor(Color.rgb(11, 16, 24))
        }
        val heading = TextView(this).apply {
            text = title
            textSize = 22f
            setTextColor(Color.rgb(220, 229, 235))
            gravity = Gravity.CENTER
        }
        val message = TextView(this).apply {
            text = detail
            textSize = 13f
            setTextColor(Color.rgb(160, 174, 184))
            gravity = Gravity.START
            setTextIsSelectable(true)
            setPadding(0, 20, 0, 20)
        }
        val scroll = ScrollView(this).apply { addView(message) }
        content.addView(heading, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        content.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val copy = Button(this).apply {
            text = "کپی گزارش فنی"
            setOnClickListener {
                val report = buildString {
                    appendLine("XsayaTrade diagnostic report")
                    appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
                    appendLine("Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                    appendLine("WebView: ${webViewProviderVersion()}")
                    appendLine("Screen: $title")
                    appendLine(detail)
                }
                val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("XsayaTrade diagnostics", report))
                Toast.makeText(this@MainActivity, "گزارش فنی کپی شد؛ آن را برای پشتیبانی بفرستید.", Toast.LENGTH_LONG).show()
            }
        }
        content.addView(copy, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        if (allowRetry) {
            val retry = Button(this).apply {
                text = "تلاش دوباره"
                setOnClickListener {
                    clearPreviousCrash()
                    rendererRestartAttempted = false
                    safelyOpenApp(null)
                }
            }
            content.addView(retry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(content)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView?.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        webView?.let { current ->
            (current.parent as? ViewGroup)?.removeView(current)
            current.stopLoading()
            current.webChromeClient = null
            current.webViewClient = WebViewClient()
            current.destroy()
        }
        webView = null
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val current = webView
        if (current != null && current.canGoBack()) current.goBack() else super.onBackPressed()
    }
}
