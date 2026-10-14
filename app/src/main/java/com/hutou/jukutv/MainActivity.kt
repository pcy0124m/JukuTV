package com.hutou.jukutv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast

/**
 * 剧库 · 安卓客户端。
 *
 * 就是一个 WebView 壳，但每个设置都对着一个具体的坑：
 *   - 页面来自 assets，通过 Site 冒充 https://app.local 提供，于是和 /proxy 同源，
 *     跨域问题在根上消失（这是整个方案能成立的前提）；
 *   - UA 跟桌面版一致，免得源站对手机 UA 走另一套逻辑；
 *   - keepScreenOn：看剧的时候屏幕不能自己黑；
 *   - mediaPlaybackRequiresUserGesture=false：前端 buildPlayer 之后直接 play()，
 *     不关这个会被浏览器策略挡下，表现是黑屏不播；
 *   - 返回键先走网页历史（剧库列表 → 播放页是两次导航），退到底再退出 App。
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView

    private var fullView: View? = null
    private var fullCallback: WebChromeClient.CustomViewCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Site.init(this)

        root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#0F0F14"))

        web = buildWebView()
        root.addView(web, FrameLayout.LayoutParams(MATCH, MATCH))
        setContentView(root)

        layoutSystemBars()

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web.loadUrl(Shell.START)
    }

    /* ================================================================== */
    /*  系统栏                                                            */
    /* ================================================================== */

    @Suppress("DEPRECATION")
    private fun layoutSystemBars() {
        // 内容延伸到状态栏下（前端用 --safe-top 自己让位），但状态栏本身保持可见
        window.statusBarColor = Color.TRANSPARENT
        var flags = window.decorView.systemUiVisibility
        flags = flags or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        window.decorView.systemUiVisibility = flags
    }

    /* ================================================================== */
    /*  WebView                                                           */
    /* ================================================================== */

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val w = WebView(this)
        w.setBackgroundColor(Color.parseColor("#0F0F14"))
        w.isFocusable = true
        w.isFocusableInTouchMode = true
        w.keepScreenOn = true
        w.setDownloadListener { url, _, _, _, _ -> toast("暂不支持下载：" + url) }

        val st = w.settings
        st.javaScriptEnabled = true
        st.domStorageEnabled = true
        st.databaseEnabled = true
        st.setSupportZoom(false)
        st.builtInZoomControls = false
        st.displayZoomControls = false
        st.useWideViewPort = true
        st.loadWithOverviewMode = false
        st.javaScriptCanOpenWindowsAutomatically = false
        // 不用 file://，关掉更安全；assets 走 Site 读，不受这个开关影响
        st.allowFileAccess = false
        st.allowContentAccess = false
        st.cacheMode = WebSettings.LOAD_DEFAULT
        st.userAgentString = Shell.UA

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            st.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            // buildPlayer 后直接 play()，不关这个会被拦
            st.mediaPlaybackRequiresUserGesture = false
        }

        w.addJavascriptInterface(Bridge(), "JKShell")

        w.webViewClient = object : WebViewClient() {

            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = Site.handle(request)

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val u = request.url?.toString() ?: return true
                // 只认自家虚拟域名；外面的链接（广告跳转之类）一律留在原地
                return !u.startsWith(Shell.BASE)
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError
            ) {
                // 这个重载本身是 API 23 才有的，低版本系统不会走到这里
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
                if (!request.isForMainFrame) return
                showFatal("页面加载失败", error.description?.toString() ?: "")
            }
        }

        w.webChromeClient = object : WebChromeClient() {

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                fullView = view
                fullCallback = callback
                view.isKeepScreenOn = true
                root.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
                web.visibility = View.GONE
            }

            override fun onHideCustomView() {
                hideCustomView()
            }
        }

        w.requestFocus()
        return w
    }

    private fun showFatal(title: String, detail: String) {
        val html = StringBuilder()
        html.append("<!DOCTYPE html><meta name='viewport' content='width=device-width,initial-scale=1'>")
        html.append("<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;")
        html.append("background:#0F0F14;color:#EDEDED;font-family:sans-serif;text-align:center;padding:24px}")
        html.append("h2{font-size:17px;font-weight:500;margin:0 0 10px}p{font-size:13px;color:#9A9A9A;margin:0 0 18px}")
        html.append("button{background:#7C3AED;color:#fff;border:0;border-radius:10px;padding:11px 26px;font-size:14px}</style>")
        html.append("<div><h2>").append(title).append("</h2><p>")
            .append(detail.replace("<", "&lt;")).append("</p>")
        html.append("<button onclick='location.href=\"").append(Shell.START).append("\"'>重试</button></div>")
        web.loadDataWithBaseURL(Shell.BASE, html.toString(), "text/html", "utf-8", null)
    }

    /* ================================================================== */
    /*  JS 桥                                                             */
    /* ================================================================== */

    private inner class Bridge {

        @JavascriptInterface
        fun exit() {
            runOnUiThread { finish() }
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show() }
        }

        /** 状态栏高度，单位 dp（等价于网页里的 CSS px），前端拿去当 padding */
        @JavascriptInterface
        fun safeTop(): Int {
            return try {
                val id = resources.getIdentifier("status_bar_height", "dimen", "android")
                val px = if (id > 0) resources.getDimensionPixelSize(id) else 0
                Math.round(px / resources.displayMetrics.density)
            } catch (e: Throwable) {
                0
            }
        }

        @JavascriptInterface
        fun setOrientation(mode: String) {
            runOnUiThread {
                requestedOrientation = when (mode) {
                    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
            }
        }

        /** 切到电视直播模块（横屏，自带频道列表，按返回回到剧库） */
        @JavascriptInterface
        fun openLive() {
            runOnUiThread {
                try {
                    startActivity(Intent(this@MainActivity, LiveActivity::class.java))
                } catch (e: Throwable) {
                    toast("直播模块启动失败：" + (e.message ?: "未知错误"))
                }
            }
        }

        @JavascriptInterface
        fun version(): String = "0.2.0"
    }

    /* ================================================================== */
    /*  返回键                                                            */
    /* ================================================================== */

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (fullView != null) {
            hideCustomView()
            return
        }
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        super.onBackPressed()
    }

    private fun hideCustomView() {
        val v = fullView ?: return
        root.removeView(v)
        web.visibility = View.VISIBLE
        fullView = null
        fullCallback?.onCustomViewHidden()
        fullCallback = null
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        layoutSystemBars()
    }

    override fun onDestroy() {
        try {
            root.removeAllViews()
            web.destroy()
        } catch (e: Throwable) {
            // 结束阶段，忽略
        }
        super.onDestroy()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    }
}
