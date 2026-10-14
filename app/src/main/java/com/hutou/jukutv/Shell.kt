package com.hutou.jukutv

import android.net.Uri
import java.util.Locale

/**
 * 壳里的公共常量与小工具。
 *
 * 这里的 UA / Referer 规则刻意和桌面版 server.js 的 proxyRequest 保持一致，
 * 否则同一部片在电脑上能播、在手机上播不出来，排查起来很费劲。
 */
object Shell {

    /** 虚拟域名：WebView 里所有请求都打在它身上，由 Site 拦截后分发 */
    const val HOST = "app.local"
    const val BASE = "https://app.local"

    /** 起始页 */
    const val START = "$BASE/index.html"

    const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"

    /** 上游请求失败时的兜底 Referer */
    private const val FALLBACK_REFERER = "https://dbzy.tv/"

    /**
     * 按目标站点给 Referer —— 防盗链基本只看这一项。
     * 和 server.js 的映射表一致。
     */
    fun refererFor(target: String): String {
        val u = try {
            Uri.parse(target)
        } catch (e: Throwable) {
            null
        }
        val host = (u?.host ?: "").lowercase(Locale.US)
        return when {
            host.contains("live.bilibili") -> "https://live.bilibili.com/"
            host.contains("bilibili") || host.contains("bilivideo") || host.contains("mountaintoys") ->
                "https://www.bilibili.com/"
            host.contains("byteimg") || host.contains("douyinpic") -> "https://fanqienovel.com/"
            else -> {
                val scheme = u?.scheme
                if (scheme.isNullOrEmpty() || host.isEmpty()) FALLBACK_REFERER
                else "$scheme://$host/"
            }
        }
    }

    /** 按扩展名猜 MIME（assets 里的本地文件走这条） */
    fun mimeOf(path: String): String {
        val p = path.substringBefore('?').substringBefore('#').lowercase(Locale.US)
        return when {
            p.endsWith(".html") || p.endsWith(".htm") -> "text/html"
            p.endsWith(".js") || p.endsWith(".mjs") -> "application/javascript"
            p.endsWith(".css") -> "text/css"
            p.endsWith(".json") -> "application/json"
            p.endsWith(".svg") -> "image/svg+xml"
            p.endsWith(".png") -> "image/png"
            p.endsWith(".jpg") || p.endsWith(".jpeg") -> "image/jpeg"
            p.endsWith(".webp") -> "image/webp"
            p.endsWith(".gif") -> "image/gif"
            p.endsWith(".ico") -> "image/x-icon"
            p.endsWith(".woff2") -> "font/woff2"
            p.endsWith(".woff") -> "font/woff"
            p.endsWith(".ttf") -> "font/ttf"
            p.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
            p.endsWith(".ts") -> "video/mp2t"
            p.endsWith(".mp4") -> "video/mp4"
            p.endsWith(".txt") -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    /** 文本类 MIME 需要明确 charset，否则中文会乱码 */
    fun isText(mime: String): Boolean {
        val m = mime.lowercase(Locale.US)
        return m.startsWith("text/") ||
            m.contains("javascript") ||
            m.contains("json") ||
            m.contains("svg") ||
            m.contains("mpegurl")
    }

    /** 判断这个地址是不是 HLS 清单 */
    fun looksLikeM3u8(url: String, contentType: String): Boolean {
        val u = url.substringBefore('?').lowercase(Locale.US)
        if (u.endsWith(".m3u8")) return true
        val ct = contentType.lowercase(Locale.US)
        return ct.contains("mpegurl") || ct.contains("m3u8")
    }

    /** 把 target 包成本地 /proxy 地址（给 m3u8 重写用） */
    fun proxyUrl(absolute: String): String =
        "$BASE/proxy?url=" + Uri.encode(absolute)
}
