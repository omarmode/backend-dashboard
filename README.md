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

## التطبيقات المدعومة في لوحة التحكم

1. **تطبيق فرز (Farz) — التاب 1:**
   - تطبيق فرز الأساسي للوحات المركبات.
   - بادئة الكود: `FARZ-XXXX-XXXX`.
   - لون التاب: أزرق.

2. **تطبيق فرزون (Farzon) — التاب 2:**
   - تطبيق فرزون المتطور.
   - بادئة الكود المعتمدة: `FARZON-XXXX-XXXX`.
   - لون التاب: أخضر هادئ (Pastel Green).
   - صفحة التسجيل والتفعيل عبر الويب: `/farzon/register`.

---

## مسارات الـ API

### 1) `POST /api/verify-code` (التحقق العام والتفعيل)

```json
{
  "code": "FARZON-XXXX-XXXX",
  "deviceId": "android-id",
  "mode": "activate",
  "app_id": "FARZON"
}
```

`mode` يكون `activate` عند إدخال الكود، و `heartbeat` عند الفحص الدوري.

### 2) `POST /api/farzon/register` (تسجيل وتفعيل أجهزة Farzon)

```json
{
  "code": "FARZON-XXXX-XXXX",
  "deviceId": "device-uuid",
  "clientName": "اسم العميل"
}
```

### 3) `POST /api/farzon/activity` (تسجيل نبض ونشاط Farzon)

```json
{
  "code": "FARZON-XXXX-XXXX",
  "deviceId": "device-uuid"
}
```

---

## لوحة التحكم

بعد تسجيل الدخول يمكنك:
- التبديل بين تبويب **تطبيق فرز (Farz)** وتبويب **Farzon**.
- إنشاء أكواد جديدة مخصصة لكل تطبيق تبدأ بالبادئة الصحيحة تلقائياً.
- متابعة وتفعيل وحظر وطرد الأجهزة المرتبطة لكل تطبيق بشكل مستقل.
- الوصول لصفحة تفعيل وتسجيل أجهزة Farzon مباشرة.

