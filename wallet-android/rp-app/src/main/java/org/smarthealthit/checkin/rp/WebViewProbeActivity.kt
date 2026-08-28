package org.smarthealthit.checkin.rp

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity

/** Loads the web demo in a WebView and reports whether the DC API exists there. */
class WebViewProbeActivity : ComponentActivity() {
    companion object {
        const val TAG = "SHCRpWebView"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.i(TAG, "console: ${message.message()}")
                return true
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(
                    """(() => {
                        const r = {
                          hasCredentials: !!navigator.credentials,
                          hasGet: !!(navigator.credentials && navigator.credentials.get),
                          hasDigitalCredential: typeof DigitalCredential !== 'undefined',
                          hasIdentityCredential: typeof IdentityCredential !== 'undefined',
                          ua: navigator.userAgent,
                        };
                        if (r.hasGet) {
                          const orig = navigator.credentials.get.bind(navigator.credentials);
                          navigator.credentials.get = (o) => {
                            const p = orig(o);
                            p.then(v => console.log('PROBE get resolved ' + JSON.stringify(v).slice(0, 200)),
                                   e => console.log('PROBE get rejected ' + e.name + ': ' + e.message));
                            return p;
                          };
                        }
                        return JSON.stringify(r);
                    })()""".trimIndent(),
                ) { Log.i(TAG, "probe: $it") }
            }
        }
        setContentView(webView)
        webView.loadUrl(RpMainActivity.DEMO_URL)
    }
}
