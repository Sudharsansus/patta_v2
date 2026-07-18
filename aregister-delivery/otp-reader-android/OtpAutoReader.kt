package com.mypropertyqr.otp

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.provider.Telephony
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Silent OTP auto-reader for the Tamil Nadu land-records (patta/chitta) flow.
 *
 * All TN e-Services OTPs arrive from the SAME sender, so we register a runtime
 * SMS receiver, keep ONLY messages whose sender matches, pull the numeric code,
 * and hand it back. Every other SMS on the device is ignored and never read.
 *
 * Flow in the app:
 *   1) POST the Patta payload to  /api/patta/start   -> { referenceId }
 *   2) otpReader.start(SENDER) { otp -> POST /api/patta/verify {referenceId, otp} }
 *   3) The govt SMS lands -> onOtp fires -> you submit it. No typing, no refresh.
 *
 * PERMISSION: needs RECEIVE_SMS (declare in the manifest AND request at runtime on
 * Android 6+; see requestSmsPermission() below). Google Play RESTRICTS RECEIVE_SMS
 * to default-SMS apps / approved use cases — so ship this build via direct APK or
 * enterprise/MDM. For a Play-Store build, use the SMS User Consent variant instead
 * (see README) — same result, one extra tap, no special permission.
 */
class OtpAutoReader(private val context: Context) {

    /** 4-8 digit code, taken as the first standalone number in the message body. */
    private val otpRegex = Regex("(?<!\\d)(\\d{4,8})(?!\\d)")

    private var receiver: BroadcastReceiver? = null

    /**
     * Start listening. [senderContains] is matched case-insensitively against the
     * SMS originating address (use a distinctive part of the TN govt sender id).
     * [onOtp] is invoked once with the code, then listening stops automatically.
     * A [timeoutMs] safety net stops listening if no matching SMS ever arrives.
     */
    fun start(
        senderContains: String,
        timeoutMs: Long = 90_000,
        onTimeout: (() -> Unit)? = null,
        onOtp: (String) -> Unit,
    ) {
        stop()
        val rec = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
                val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
                // A long OTP SMS is split into parts — join them before matching.
                val bySender = HashMap<String, StringBuilder>()
                for (sms in messages) {
                    val from = sms.displayOriginatingAddress ?: continue
                    bySender.getOrPut(from) { StringBuilder() }.append(sms.messageBody ?: "")
                }
                for ((from, body) in bySender) {
                    if (!from.contains(senderContains, ignoreCase = true)) continue
                    val otp = otpRegex.find(body.toString())?.groupValues?.get(1) ?: continue
                    Log.d(TAG, "OTP captured from $from")
                    stop()
                    onOtp(otp)
                    return
                }
            }
        }
        receiver = rec
        val filter = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
        // RECEIVER_EXPORTED: the SMS broadcast originates from the OS (Android 13+).
        ContextCompat.registerReceiver(context, rec, filter, ContextCompat.RECEIVER_EXPORTED)

        timeoutRunnable = Runnable {
            if (receiver != null) { stop(); onTimeout?.invoke() }
        }.also { handler.postDelayed(it, timeoutMs) }
    }

    /** Stop listening (idempotent). Always call from onDestroy() as well. */
    fun stop() {
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null

    companion object {
        private const val TAG = "OtpAutoReader"

        /** True if RECEIVE_SMS is already granted. */
        fun hasSmsPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) ==
                PackageManager.PERMISSION_GRANTED
    }
}
