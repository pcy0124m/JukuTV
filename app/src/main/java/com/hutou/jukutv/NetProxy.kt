package com.hutou.jukutv

import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

/**
 * 上游转发。
 *
 * 这是整个壳里唯一有技术含量的部分：把桌面版 server.js 的 handleProxy + proxyRequest +
 * rewriteM3u8 三件事合成一个对象。要点：
 *
 *   1. 手动跟重定向（最多 4 跳），因为每跳都要重算 Referer；
 *   2. m3u8 读全文重写，把分片地址换成 https://app.local/proxy?url=... —— 这样 hls.js
 *      后续所有请求都落在同源，彻底躲开 CORS 和防盗链；
 *   3. 分片/视频流式转发，透传 Range / Content-Range / Content-Length，否则拖进度条会废。
 */
object NetProxy {

    private const val MAX_HOP = 4
    private const val CONNECT_TIMEOUT = 15000
    private const val READ_TIMEOUT = 30000

    /** 管道缓冲：太小会频繁阻塞，太大白白吃内存 */
    private const val PIPE_BUFFER = 512 * 1024

    private const val M3U8_MIME = "application/vnd.apple.mpegurl"

    fun proxy(target: String, range: String?): WebResourceResponse {
        val hop = try {
            connect(target, range)
        } catch (e: Throwable) {
            return Site.fail(502, "连不上源站：" + (e.message ?: e.javaClass.simpleName))
        } ?: return Site.fail(502, "源站跳转次数过多或地址无效")

        val conn = hop.conn
        val finalUrl = hop.url
        val code = hop.code

        val m3u8 = Shell.looksLikeM3u8(finalUrl, hop.contentType)
        if (m3u8 && range.isNullOrEmpty()) {
            return readAndRewrite(conn, finalUrl)
        }
        return streamThrough(conn, finalUrl, code)
    }

    /* ------------------------------------------------------------------ */

    private class Hop(val conn: HttpURLConnection, val url: String, val code: Int, val contentType: String)

    private fun connect(target: String, range: String?): Hop? {
        var url = target
        for (i in 0 until MAX_HOP) {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.setRequestProperty("User-Agent", Shell.UA)
            conn.setRequestProperty("Referer", Shell.refererFor(url))
            conn.setRequestProperty("Accept", "*/*")
            // 不让上游压缩：重写 m3u8 时省一道解压，也让 Content-Length 保持真实
            conn.setRequestProperty("Accept-Encoding", "identity")
            if (!range.isNullOrEmpty()) conn.setRequestProperty("Range", range)

            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location") ?: ""
                conn.disconnect()
                if (loc.isEmpty()) return null
                url = try {
                    URL(URL(url), loc).toString()
                } catch (e: Throwable) {
                    return null
                }
                continue
            }
            val ct = (conn.contentType ?: "").substringBefore(';').trim()
            return Hop(conn, url, code, ct)
        }
        return null
    }

    /** m3u8：全文读进来，重写所有分片地址 */
    private fun readAndRewrite(conn: HttpURLConnection, finalUrl: String): WebResourceResponse {
        return try {
            val text = body(conn).bufferedReader(Charsets.UTF_8).use { it.readText() }
            conn.disconnect()
            val out = rewrite(text, finalUrl)
            val h = HashMap<String, String>()
            h["Cache-Control"] = "no-cache"
            WebResourceResponse(
                M3U8_MIME, "utf-8", 200, "OK", h,
                ByteArrayInputStream(out.toByteArray(Charsets.UTF_8))
            )
        } catch (e: Throwable) {
            conn.disconnect()
            Site.fail(502, "播放清单读取失败：" + (e.message ?: e.javaClass.simpleName))
        }
    }

    /** 分片 / 图片 / 其它：原样流式转发 */
    private fun streamThrough(conn: HttpURLConnection, finalUrl: String, code: Int): WebResourceResponse {
        val raw: InputStream = try {
            body(conn)
        } catch (e: Throwable) {
            val err = conn.errorStream
            if (err == null) {
                conn.disconnect()
                return Site.fail(502, "源站没有返回内容")
            }
            return WebResourceResponse(
                "text/plain", "utf-8", code, "ERR",
                HashMap<String, String>(), err
            )
        }
        val h = HashMap<String, String>()
        h["Cache-Control"] = "no-cache"
        h["Access-Control-Allow-Origin"] = "*"
        h["Accept-Ranges"] = conn.getHeaderField("Accept-Ranges") ?: "bytes"
        conn.getHeaderField("Content-Range")?.let { h["Content-Range"] = it }

        // 只有没被压缩时 Content-Length 才可信
        val enc = (conn.getHeaderField("Content-Encoding") ?: "").lowercase(Locale.US)
        if (enc.isEmpty()) {
            conn.getHeaderField("Content-Length")?.let { h["Content-Length"] = it }
        }

        // 优先用上游给的 Content-Type；它常常是空的或是 octet-stream，再用扩展名兜底
        val upstreamMime = (conn.contentType ?: "").substringBefore(';').trim()
        val mime = when {
            upstreamMime.isEmpty() -> Shell.mimeOf(finalUrl)
            upstreamMime.contains("octet-stream") -> Shell.mimeOf(finalUrl)
            else -> upstreamMime
        }
        val encoding = if (Shell.isText(mime)) "utf-8" else null

        return WebResourceResponse(
            mime, encoding, code, "OK", h,
            Closing(pipe(raw), conn)
        )
    }

    /** 读上游响应体，顺带处理上游无视 identity 硬压缩的情况 */
    private fun body(conn: HttpURLConnection): InputStream {
        val raw = conn.inputStream
        val enc = (conn.getHeaderField("Content-Encoding") ?: "").lowercase(Locale.US)
        return when {
            enc.contains("gzip") -> GZIPInputStream(raw)
            enc.contains("deflate") -> InflaterInputStream(raw)
            else -> raw
        }
    }

    /* ------------------------------------------------------------------ */

    /**
     * 用管道把「搬运数据」挪到后台线程。
     *
     * shouldInterceptRequest 有被 WebView 串行调用的可能，一个 5MB 的分片如果在这里
     * 同步读完，后面所有请求都得排队，表现就是播放一直卡。连接阶段（拿响应码和响应头）
     * 仍然同步——但它通常几百毫秒就回来了，真正耗时的字节搬运交给线程池。
     */
    private val io = Executors.newFixedThreadPool(4)

    private fun pipe(open: () -> InputStream): InputStream {
        val out = PipedOutputStream()
        val inp = try {
            PipedInputStream(out, PIPE_BUFFER)
        } catch (e: Throwable) {
            return ByteArrayInputStream(ByteArray(0))
        }
        io.execute {
            var src: InputStream? = null
            try {
                src = open()
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = src.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    out.flush()
                }
            } catch (e: Throwable) {
                // 读端提前关闭 或 上游断开，都算正常收场
            } finally {
                try {
                    src?.close()
                } catch (e: Throwable) {
                }
                try {
                    out.close()
                } catch (e: Throwable) {
                }
            }
        }
        return inp
    }

    /* ------------------------------------------------------------------ */

    /**
     * m3u8 重写。
     *
     * 两种行要处理：
     *   - 裸地址行（分片 / 子清单）→ 整行换成 proxy 地址
     *   - #EXT-X-KEY / #EXT-X-MAP 这类带 URI="..." 的标签 → 只换引号里的内容
     * 相对路径按 baseUrl 解析成绝对地址后再包，否则 hls.js 会拿错基址。
     */
    fun rewrite(body: String, baseUrl: String): String {
        val sb = StringBuilder(body.length + 512)
        for (raw in body.split("\n")) {
            val t = raw.trim()
            when {
                t.isEmpty() -> sb.append(raw)

                t.startsWith("#") -> {
                    if (t.contains("URI=\"")) sb.append(rewriteAttr(raw, baseUrl)) else sb.append(raw)
                }

                else -> {
                    val abs = resolve(baseUrl, t)
                    if (abs == null) sb.append(raw) else sb.append(Shell.proxyUrl(abs))
                }
            }
            sb.append('\n')
        }
        return sb.toString()
    }

    private val uriAttr = Regex("URI=\"([^\"]+)\"")

    private fun rewriteAttr(line: String, baseUrl: String): String {
        val m = uriAttr.find(line) ?: return line
        val raw = m.groupValues[1]
        if (raw.isEmpty()) return line
        val abs = resolve(baseUrl, raw) ?: return line
        return line.replace(raw, Shell.proxyUrl(abs))
    }

    private fun resolve(base: String, ref: String): String? = try {
        URL(URL(base), ref).toString()
    } catch (e: Throwable) {
        null
    }

    /** 关闭流时顺手断开连接，避免 keep-alive 连接堆着不放 */
    private class Closing(inner: InputStream, private val conn: HttpURLConnection) :
        FilterInputStream(inner) {
        override fun close() {
            try {
                super.close()
            } catch (e: IOException) {
                // 上游已经断了，忽略
            }
            try {
                conn.disconnect()
            } catch (e: Throwable) {
                // 同上
            }
        }
    }
}
