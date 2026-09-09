# نظام ترخيص FARZ — الباك أند ولوحة التحكم

مجلد مستقل لخادم الترخيص ولوحة الإدارة، متصل بـ **Supabase (PostgreSQL)**. تطبيق الأندرويد يتصل به عبر:

`POST /api/verify-code`

---

## التشغيل المحلي

### 1) المتطلبات
- Node.js 18 أو أحدث
- مشروع Supabase جاهز

### 2) تهيئة قاعدة البيانات
افتح SQL Editor في Supabase ونفّذ ملف `schema.sql`، أو استخدم الهجرة المطبَّقة على المشروع.

الجداول:
- `admin`
- `activation_codes`

### 3) تثبيت الحزم
من مجلد `backend-dashboard`:

```bash
npm install
```

### 4) ملف البيئة `.env`

```
PORT=3000
SUPABASE_URL=https://khiptabndxlmfltrvkfh.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-or-publishable-key
NODE_ENV=production
SESSION_SECRET=ضع-مفتاحا-طويلا-وعشوائيا
ADMIN_USERNAME=admin
ADMIN_PASSWORD=كلمة-مرور-قوية
```

عند تشغيل السيرفر يتم إنشاء/تحديث حساب المدير تلقائياً من `ADMIN_USERNAME` و `ADMIN_PASSWORD`.

### 5) تشغيل السيرفر

```bash
npm start
```

ثم افتح:

- لوحة التحكم: http://localhost:3000/admin
- فحص الصحة: http://localhost:3000/api/health

---

## ربط تطبيق الأندرويد

في جذر مشروع الأندرويد أنشئ أو عدّل ملف `.env`:

```
LICENSE_API_BASE_URL=http://10.0.2.2:3000/
```

| الجهاز | قيمة `LICENSE_API_BASE_URL` |
|---|---|
| محاكي أندرويد | `http://10.0.2.2:3000/` |
| هاتف حقيقي على نفس الشبكة | `http://IP-الكمبيوتر:3000/` |
| بعد الرفع على Render | `https://your-service.onrender.com/` |

يجب أن ينتهي الرابط بشرطة `/`. بعد التعديل أعد بناء التطبيق (Rebuild).

---

## الرفع على Render

1. ارفع مشروع الباك أند إلى GitHub.
2. في Render أنشئ Web Service.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. أضف متغيرات البيئة:

```
NODE_ENV=production
SUPABASE_URL=https://khiptabndxlmfltrvkfh.supabase.co
SUPABASE_ANON_KEY=your-key
SESSION_SECRET=مفتاح-عشوائي-طويل
ADMIN_USERNAME=admin
ADMIN_PASSWORD=كلمة-مرور-قوية
```

6. بعد النشر ضع رابط الخدمة في `.env` الخاص بالأندرويد:

```
LICENSE_API_BASE_URL=https://your-service.onrender.com/
```

---

## مسارات الـ API

### `POST /api/verify-code`

```json
{
  "code": "FARZ-XXXX-XXXX",
  "deviceId": "android-id",
  "mode": "activate"
}
```

`mode` يكون `activate` عند إدخال الكود، و `heartbeat` عند الفحص الدوري.

حالات `status`:
- `valid`
- `invalid`
- `expired`
- `blocked`
- `device_mismatch`
- `logged_out`

---

## لوحة التحكم

بعد تسجيل الدخول يمكنك:
- إنشاء أكواد جديدة بالمدة (أيام أو شهور)
- عرض الأكواد و Device ID المرتبط
- حظر / تعطيل الكود
- طرد الجهاز (Force Logout)
- حذف الكود
