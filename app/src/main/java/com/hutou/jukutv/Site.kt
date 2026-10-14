package com.hutou.jukutv

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * 拦截路由 —— 整个 APK 的「虚拟后端」入口。
 *
 * WebView 里页面跑在 https://app.local 下，所有请求都先落到这里：
 *
 *   https://app.local/xxx             → assets/www/ 下的静态文件
 *   https://app.local/proxy?url=XXX   → NetProxy 转发到 XXX（m3u8 会被重写）
 *   http(s)://其它域名                 → 兜底转发（m3u8 重写漏网的地址不至于被 CORS 拦死）
 *
 * 注意：本文件里的块注释**不能出现斜杠加星号**那两个字。
 * Kotlin 的块注释是可嵌套的，那个组合会开一层新注释，把后面的代码整段吞掉，
 * 报错却是文件末尾一句莫名其妙的「Unclosed comment」，排查半天。
 * 上面第一行原来就是写成通配符的样子，踩过一次。
 *
 * 关键收益：页面和接口同源，浏览器那套跨域规则完全用不上，
 * 前端代码不需要再加任何 Access-Control 相关的处理。
 */
object Site {

    private var app: Context? = null

    fun init(ctx: Context) {
        app = ctx.applicationContext
    }

    fun handle(req: WebResourceRequest?): WebResourceResponse? {
        val uri = req?.url ?: return null
        val scheme = (uri.scheme ?: "").lowercase()
        // data: / blob: / about: 一律放行给 WebView 自己处理
        if (scheme != "http" && scheme != "https") return null

        val range = req.requestHeaders?.get("Range")

        if (uri.host == Shell.HOST) {
            when (uri.path) {
                "/proxy" -> {
                    val target = uri.getQueryParameter("url")
                    if (target.isNullOrEmpty()) return fail(400, "缺少 url 参数")
                    return NetProxy.proxy(target, range)
                }

                "/__alive" -> return text("ok")

                else -> return asset(uri.path ?: "/")
            }
        }

        // 外部地址：正常不会走到这里（m3u8 已被全量改写），留作兜底
        return NetProxy.proxy(uri.toString(), range)
    }

    /* ------------------------------------------------------------------ */

    private fun asset(rawPath: String): WebResourceResponse {
        val ctx = app ?: return fail(500, "壳还没初始化")
        var p = rawPath.substringBefore('?').substringBefore('#')
        while (p.startsWith("/")) p = p.substring(1)
        if (p.contains("..")) return fail(403, "路径非法")
        if (p.isEmpty() || p.endsWith("/")) p += "index.html"

        val mime = Shell.mimeOf(p)
        return try {
            val stream: InputStream = ctx.assets.open("www/$p")
            val h = HashMap<String, String>()
            h["Cache-Control"] = "no-cache"
            if (Shell.isText(mime)) {
                WebResourceResponse(mime, "utf-8", 200, "OK", h, stream)
            } else {
                WebResourceResponse(mime, null, 200, "OK", h, stream)
            }
        } catch (e: Throwable) {
            fail(404, "资源不存在：" + p)
        }
    }

    fun text(body: String): WebResourceResponse = bytes(
        "text/plain", 200, "OK", body.toByteArray(Charsets.UTF_8)
    )

    fun fail(code: Int, msg: String): WebResourceResponse = bytes(
        "text/plain", code, "ERR", msg.toByteArray(Charsets.UTF_8)
    )

    private fun bytes(mime: String, code: Int, reason: String, data: ByteArray): WebResourceResponse =
        WebResourceResponse(
            mime, "utf-8", code, reason,
            HashMap<String, String>(),
            ByteArrayInputStream(data)
        )
}
