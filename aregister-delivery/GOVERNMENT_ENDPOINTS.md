# Tamil Nadu Government Endpoints — Complete Reference

All endpoints verified as of 2026-07-13. US IPs are blocked by Indian government
firewall — must run from Indian VPS or Indian residential IP.

---

## 1. TNSERVICES — eservices.tn.gov.in
**Purpose**: Patta, Chitta, A-Register, FMB (land revenue records)

### Form (English)
```
GET https://eservices.tn.gov.in/eservicesnew/land/chittaExtract_en.html?lan=en
GET https://eservices.tn.gov.in/eservicesnew/land/chittaExtract_ta.html?lan=ta
```

### Form (Tamil)
```
GET https://eservices.tn.gov.in/eservicesnew/land/chittaExtract_ta.html?lan=ta
```

### Send OTP
```
POST https://eservices.tn.gov.in/eservicesnew/land/ajax.html?page=otpgeneratenew
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Body: mobileno=<mobile>&actionid=AC01&lan=en&TOKEN=<ajax_rno>
```

### Verify OTP
```
POST https://eservices.tn.gov.in/eservicesnew/land/ajax.html?page=verify_otp_new
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Body: mobileno=<mobile>&otpno=<otp>&TOKEN=<ajax_rno>

Response: { new_tk: <next token>, kno: <mobile[3:7]>, ... }
```

### Dropdowns (no OTP needed)
```
POST https://eservices.tn.gov.in/eservicesnew/land/ajax.html
  ?page=ruralservice&ser=dist&lang=en&type=rur&call_type=ser
  → [{ dcode, dname, dtname }] × 38 districts

POST ...?page=ruralservice&ser=tlk&distcode=<N>&lang=en&type=rur&call_type=ser
  → [{ tcode, tname, ttname, nflag: "Y"|"N" }]  ← nflag is the /Y suffix

POST ...?page=ruralservice&ser=vill&distcode=<N>&talukcode=<N>&lang=en&type=rur&call_type=ser
  → [{ villagecode, villagename, villagetname }]

POST ...?page=getSubdivNo&districtCode=<N>&talukCode=<N>/Y&villageCode=<N>&surveyno=<N>&landtype=R&flag=F
  → XML: <root><flag>true|false</flag><subdiv><subdivcode>1A</subdivcode><subdivname>...</subdivname></subdiv></root>
```

### Fetch Chitta
```
POST https://eservices.tn.gov.in/eservicesnew/land/chittaExtract_en.html?lan=en
Content-Type: application/x-www-form-urlencoded
Body: (16 fields - see below)
```

**Form fields (all 16 required)**:
| Field | Value | Notes |
|---|---|---|
| task | `chittaEng` | |
| searchpattano | `no` | "yes" if using patta number |
| chkrno | `<from GET form>` | **SINGLE-USE** — re-GET per chitta |
| ajax_rno | `<from GET form>` | rotates on each call |
| districtCode | e.g. `17` | |
| talukCode | e.g. `01` | **strip /Y** for chitta submit |
| villageCode | e.g. `092` | |
| viewOpt | `sur` \| `pt` | Sur=with FMB, Pt=full details |
| landtype | `R` \| `N` | Rural \| Natham |
| pattaNo | (empty if survey) | |
| surveyNo | e.g. `1` | |
| subdivNo | e.g. `1A1` | |
| mobileno | `<verified_mobile>` | ACTUAL mobile value |
| mobileno_ver | `<mobile>` | **ACTUAL value, not "true"** |
| otpno | `<verified_otp>` | ACTUAL OTP value |
| otpno_ver | `<otpno>` | **ACTUAL value, not "true"** |

### A-Register (additional land record)
```
GET https://eservices.tn.gov.in/eservicesnew/land/aRegisterExtract_en.html?lan=en
```

---

## 2. TNREGINET — tnreginet.gov.in
**Purpose**: Encumbrance Certificate (EC), Document Copy, Certified Copy,
Marriage, Society, Chit Fund, Guideline Value

### EC Search Page (open the form)
```
GET https://tnreginet.gov.in/portal/webHP
  ?requestType=ApplicationRH
  &actionVal=openEncumbranceCertSearch
  &screenId=8400001
  &scenarioId=2
  &menuCode=8400010
  &auditUSFlag=true
```

### EC Dropdowns (cascading)
```
POST https://tnreginet.gov.in/portal/webHP
  ?requestType=ApplicationRH
  &actionVal=loadDistrictCombo&queryType=Select&screenId=8400001&comboValue=<zoneId>

POST ...&actionVal=loadSroCombo&queryType=Select&screenId=8400001&comboValue=<districtId>

POST ...&actionVal=loadRevenueTalukaCombo&queryType=Select&screenId=8400001&comboValue=<districtId>

POST ...&actionVal=loadRevenueVillageCombo&queryType=Select&screenId=8400001&comboValue=<talukId>

POST ...&actionVal=loadVillageCombo&queryType=Select&screenId=8400001&comboValue=<sroId>
```

### EC Search Submit
```
POST https://tnreginet.gov.in/portal/webHP
  ?requestType=ApplicationRH
  &actionVal=searchDocYearWise
  &screenId=8400001
  &divId=searchComponentSection
  &isRevenueVillage=false
  &isPlotFlatWise=false
  &villageList=<villageCode>
  &_csrf=<csrf_token>

Body: (form-urlencoded, see fields below)
```

### Required Hidden Fields
```js
{
  requestType: "ApplicationRH",
  actionVal: "searchDocYearWise",
  screenId: "8400001",
  menuCode: "8400010",
  formId: "EncumbranceCertificateForm",
  isRevenueVillage: "false",
  showBookFlag: "false",
  showDateFlag: "true",
  applyOnline: "false",
  loggedInGuest: "true",
  authToken: "<from GET form>",
  _csrf: "<from GET form>",
  browserDetails: ""
}
```

### EC Search Criteria
```js
{
  zoneId: "1",
  districtId: "17",
  sroId: "20051",
  villageCode: "63089",
  surveyNo: "2689",
  flatNo: "",
  plotNo: "",
  ecPeriodStartDt: "01/01/2015",
  ecPeriodEndDt: "31/12/2025",
  isPlotFlatWise: "false"
}
```

### Captcha Reset
```
POST ...&actionVal=resetSession&queryType=Select&screenId=114
Body: _csrf=<token>
```

### Captcha Validate
```
POST ...&actionVal=checkCaptcha&queryType=Select&screenId=114&captcha_val=<value>
```

### Personal Details Submit (after EC results)
```
POST ...&actionVal=saveViewECPersonalDetails&screenId=8400001&_csrf=<token>
```

### Preview EC PDF
```
POST ...&actionVal=previewECWisePdf&screenId=8400001&appTransId=<transId>
```

### Document Copy
```
GET https://tnreginet.gov.in/portal/webHP
  ?requestType=ApplicationRH
  &actionVal=openDocumentStatus
  &screenId=7000080
  &menuCode=8500071
  &auditUSFlag=true
```

### Guideline Value
```
GET https://tnreginet.gov.in/portal/webHP
  ?requestType=ApplicationRH
  &actionVal=openGuidelineValueSearch
```

---

## 3. CollabLand — collabland-tn.gov.in
**Purpose**: FMB (Field Measurement Book) Map service

### FMB Map
```
GET https://collabland-tn.gov.in/CollabLandService/ApprovedMap/ViewMap/pdf/<HASH>
```

HASH is **unique per chitta**, extracted from chitta HTML:
```html
<embed src="https://collabland-tn.gov.in/CollabLandService/ApprovedMap/ViewMap/pdf/-FbwxwoWxr8SiupYntng0A">
```

Examples:
- Ariyalur 597 Survey 1/1A: `-FbwxwoWxr8SiupYntng0A`
- Andimadam 2689 Survey 1/2: `0vZg0vAGQzTzq3hhddSYsA`

Can be embedded as `<img>` or `<iframe>` in our app.

---

## 4. the stable-session contract — www.the stable-session contract.com (FALLBACK ONLY)
**Purpose**: Mirror client fallback for EC if TNREGINET is too hard

### Auth
```
POST https://www.the stable-session contract.com/ajax/accounts/logincheck
Body: { mobile, password, captcha: "" }

Response: { success, message }
Cookies: access_token (JWT 47.9h) + hash_key (HttpOnly)
```

### Dropdowns (no captcha)
```
POST https://www.the stable-session contract.com/api/ajax/list/get-reg-zones
POST .../get-reg-districts { zone_code }
POST .../get-reg-sros { zone_code, district_code }
POST .../get-reg-villages { zone_code, district_code, sro_code }
POST .../get-reg-rev-districts
POST .../get-reg-rev-taluks { revdistrict_code }
POST .../get-reg-rev-villages { revdistrict_code, revtaluk_code }
```

### Service Dispatch
```
POST https://www.the stable-session contract.com/api/ajax/service/preview?rnd=<5digit>
Body: { lang, server: "registration"|"eservices", service, reference_id, params }
Response: { status: "requested-sock" } or { status: "error", message }

Result via socket.io 'landabot' event on room-<reference_id>:
{
  request_id, message, msg_type: "success"|"error",
  json_data: { ... }, set_loading: "YES"|"NO"
}
```

### Socket.io Bot
```
http://www.the stable-session contract.com:8080 (NOT HTTPS)
Transports: polling, websocket (EIO=4)
```

### FAKE Tokens (the stable-session contract ignores)
```js
{
  csrf: "csrf_token",        // string literal
  security: "security_token" // string literal
}
```

---

## Reference Codes

### Tamil Nadu Districts (38)
```
01 Chennai         18 Cuddalore     35 Chengalpattu
02 Tiruvallur      19 Nagapattinam  36 Thirupathur
03 Kancheepuram    20 Thiruvarur     37 Ranipet
04 Vellore         21 Thanjavur     38 Mayiladuthurai
05 Dharmapuri      22 Pudukkottai
06 Tiruvannamalai  23 Sivagangai
07 Viluppuram      24 Madurai
08 Salem           25 Theni
09 Namakkal        26 Virudhunagar
10 Erode           27 Ramanathapuram
11 Nilgiris        28 Thoothukkudi
12 Coimbatore      29 Tirunelveli
13 Dindigul        30 Kanniyakumari
14 Karur           31 Krishnagiri
15 Trichy          32 Tiruppur
16 Perambalur      33 Kallakurichi
17 Ariyalur        34 Tenkasi
```

### Confirmed Sample Codes
```
Salem: District=08, Mettur Taluk=09, Navapatti Village=011
Ariyalur: District=17, Ariyalur Taluk=01, Alagiyamanavalam=092
       Andimadam Taluk=08, Ayyur Village=090 (in rev dept: 63089)
Erode: District=10
Pulampatti: District=10 (test case)
```

---

## Reference ID Format (TNSERVICES)

```
S/<district>/<taluk>/<village>/<padded_patta>/<unique_id>

Examples:
  S/17/01/092/00597/50281    (Ariyalur 597)
  S/17/08/090/02689/30075    (Andimadam 2689)
```

---

## Rate Limits

| Service | Limit | Reset |
|---|---|---|
| TNSERVICES chitta | 10/day/mobile | Midnight IST |
| TNREGINET EC | captcha + 100/day (no mobile limit) | Daily |
| the stable-session contract | unlimited via session pool | N/A |

---

## Quick-Start Scripts

```bash
# Test TNSERVICES (need Indian IP)
curl -s "https://eservices.tn.gov.in/eservicesnew/land/chittaExtract_en.html?lan=en" \
  -o /tmp/tnservices-form.html

# Test TNREGINET
curl -s "https://tnreginet.gov.in/portal/webHP?requestType=ApplicationRH&actionVal=openEncumbranceCertSearch&screenId=8400001&scenarioId=2&menuCode=8400010&auditUSFlag=true" \
  -o /tmp/tnreginet-ec.html

# Test CollabLand
curl -s "https://collabland-tn.gov.in/CollabLandService/ApprovedMap/ViewMap/pdf/-FbwxwoWxr8SiupYntng0A" \
  -o /tmp/fmb.pdf

# Test the stable-session contract (any IP)
curl -s "http://www.the stable-session contract.com:8080/" -o /tmp/lm-monitor.html
```

---

## Authentication Cheat Sheet

| Service | Auth Method | Duration |
|---|---|---|
| TNSERVICES | OTP per mobile (10/day) | 24-48h |
| TNREGINET | Captcha (per session) | 24h |
| CollabLand | None (public) | N/A |
| the stable-session contract | logincheck (no captcha) | 47.9h JWT |
| MPQR Bot | Customer-OTP pool | Pool-based |
