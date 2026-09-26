package ai.vexon.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import java.io.ByteArrayInputStream
import android.webkit.WebViewClient
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var backendHost: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.statusBarColor = Color.rgb(11, 16, 24)
        window.navigationBarColor = Color.rgb(11, 16, 24)
        window.decorView.systemUiVisibility = 0

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(11, 16, 24))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.safeBrowsingEnabled = true
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
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
                            // Keep the user in-app if no browser or Telegram client can handle the link.
                        }
                        return true
                    }
                    val isBundled = uri.host == "appassets.androidplatform.net" && uri.scheme == "https"
                    val isConfiguredBackend = backendHost != null && uri.host == backendHost && uri.scheme == "https"
                    return !isBundled && !isConfiguredBackend
                }
            }
        }
        setContentView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            val configuredBackend = BuildConfig.VEXON_BACKEND_URL.trim().trimEnd('/')
            if (configuredBackend.isNotEmpty()) {
                val uri = Uri.parse(configuredBackend)
                require(uri.scheme == "https" && !uri.host.isNullOrBlank()) { "Vexon backend URL must use HTTPS." }
                backendHost = uri.host
                webView.loadUrl("$configuredBackend/?native=1")
            } else {
                webView.loadUrl("https://appassets.androidplatform.net/assets/index.html?native=1")
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
