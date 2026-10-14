# 壳里全部是 Kotlin 直连，不反射第三方库
-dontwarn android.webkit.**
-keep class com.hutou.jukutv.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
