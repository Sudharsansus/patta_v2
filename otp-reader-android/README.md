# Patta OTP Auto-Reader (Android)

Silently reads the Tamil Nadu land-records OTP the instant it arrives and submits
it — no typing, no refresh. All TN e-Services OTPs come from **one fixed sender**,
so we filter on that sender and ignore every other SMS.

This is the client half. The server half is the REST API (`/api/patta/start` →
`/api/patta/verify`). The reader sits **between** them:

```
POST /api/patta/start  { ...payload }   ──► { referenceId }
otpReader.start(SENDER) { otp ->
    POST /api/patta/verify { referenceId, otp }  ──► { data: <base64 PDF> }
}
```

---

## 1. Manifest

```xml
<uses-permission android:name="android.permission.RECEIVE_SMS" />
```
No `<receiver>` entry needed — we register it at **runtime** (dynamic receiver) so
it only listens during the OTP window, then unregisters itself.

## 2. Ask for the permission at runtime (Android 6+)

```kotlin
if (!OtpAutoReader.hasSmsPermission(this)) {
    requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS), REQ_SMS)
}
```

## 3. Use it

```kotlin
private val otpReader by lazy { OtpAutoReader(applicationContext) }

// After /api/patta/start returns referenceId:
otpReader.start(
    senderContains = TN_OTP_SENDER,   // the fixed TN govt sender id (e.g. "TNGOVT")
    timeoutMs = 90_000,
    onTimeout = { showError("OTP not received — resend") },
) { otp ->
    // Auto-submit — no user typing:
    api.verify(VerifyBody(referenceId, otp))   // POST /api/patta/verify
}

override fun onDestroy() { otpReader.stop(); super.onDestroy() }
```

> **Set `TN_OTP_SENDER`** to the exact sender all your test OTPs come from — you
> have it, I don't. The matcher is a case-insensitive `contains`, so a distinctive
> substring of the sender id is enough. The code grabs the first 4–8 digit number
> in the body; if the govt format ever changes, tune `otpRegex` in `OtpAutoReader`.

---

## Google Play caveat (read this)

`RECEIVE_SMS` is **restricted** on the Play Store — apps that aren't the default
SMS handler usually get rejected. Two ways to ship:

- **Direct APK / enterprise / MDM distribution** → this silent reader works as-is.
  (Common for utility apps in India.)
- **Play Store** → use the **SMS User Consent API** instead: no permission, one
  tap per OTP, and you can still pass the sender. Sketch:

```kotlin
// start: SmsRetriever.getClient(activity).startSmsUserConsent(/* senderPhone or */ null)
// register a receiver for SmsRetriever.SMS_RETRIEVED_ACTION
// on SUCCESS -> startActivityForResult(consentIntent)   // the one tap
// onActivityResult -> val msg = data.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE)
//                     val otp = Regex("(\\d{4,8})").find(msg)?.value
```

Same end result — I can write the full User-Consent class if you go Play Store.

## iOS

Nothing to build — iOS auto-suggests the OTP above the keyboard (QuickType). The
user taps the suggestion; there's no silent-read API on iOS.

## React Native / Flutter

This native Kotlin class is the engine. If your app is RN or Flutter, it plugs in
via a thin native module / plugin (RN: `NativeModule` exposing `start/stop`;
Flutter: a `MethodChannel`). Tell me which and I'll add the bridge.
