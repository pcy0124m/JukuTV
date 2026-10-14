# 剧库 · 安卓客户端

短剧 / 连续剧 / 动漫聚合客户端。整个 App 就是一个 WebView 壳，页面资源全部打包在
`assets/www` 里，跟着 APK 一起装到手机上 —— **不依赖电脑、不依赖服务器**。

数据来自 dbzy.tv 的公开接口。

## 它和普通套壳 App 的区别

麻烦的部分全在「网页和接口不同源」上：源站不给跨域头、视频 CDN 还要校验 Referer。
桌面版是靠一个 Node 服务（`server.js`）做中转绕过去的，手机上没法起 Node，所以
这里用 `WebViewClient.shouldInterceptRequest` 在原生层接了这个活：

```
WebView  →  https://app.local/index.html      ← Site.kt 从 assets 读
        →  https://app.local/proxy?url=XXX    ← NetProxy.kt 转发到 XXX
```

页面和接口同源，浏览器那套 CORS 规则根本不参与；Referer 也由转发层统一补，
m3u8 里的分片地址会被重写成 `app.local/proxy?...`，后续所有请求都留在壳里。

## 目录

```
app/src/main/java/com/hutou/jukutv/
  Shell.kt        常量、UA、Referer 规则（和桌面版 server.js 保持一致）
  Site.kt         拦截路由：静态资源 / proxy / 兜底
  NetProxy.kt     上游转发 + m3u8 重写 + 流式管道
  MainActivity.kt WebView 宿主、全屏、返回键、JS 桥

app/src/main/assets/www/          手机版前端（深色主题）
  index.html                     剧库列表
  detail.html                    播放页
  js/juku-api.js                 数据层（桌面版 lib/juku.js 的浏览器移植）
  js/juku.js  watch.js           界面逻辑
  js/jk-player.js                自研播放器（无原生 controls）
  lib/hls.min.js                 hls.js，本地打包，离线可用
  css/mobile.css                 手机布局
```

## 本地跑

手机版前端能脱离 Android 直接预览，先过一遍再去真机：

```bash
# 1) 桌面版服务（提供 /proxy）
node server.js 8000

# 2) 用 assets 里的页面 + 把 /proxy 转给 8000
python tools/apk-preview.py 8010
# 打开 http://127.0.0.1:8010/index.html

# 3) 用移动视口自动跑一遍
python tools/apk-selftest.py
```

## 云端编译

`main` 分支推送会自动出 debug APK（Artifacts）。
打 tag 或手动触发 `Build & Sign Release` 会出签名包并发布 Release。

签名密钥通过 4 个 secret 注入：`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` /
`KEY_ALIAS` / `KEY_PASSWORD`。密钥文件本身不在仓库里（`.gitignore` 已排除）。
换密钥会导致新包必须卸载重装，所以这个 keystore 记得留备份。

## 已知情况

- 源站有多个 CDN 节点，个别节点（比如 `vodcnd15`）会整段超时。这时候某一部片就是播不了，
  换一部即可，不是客户端问题。
- 短剧大多把整部塞在一个 m3u8 里（单集时长可能到 2.5 小时），所以「自动连播下一集」
  实际只在连续剧 / 动漫分类里生效。
- 视频里烧录的贴片广告压进了视频流本身，客户端层面无法去除。
