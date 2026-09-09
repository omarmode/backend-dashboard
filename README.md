# نظام ترخيص FARZ — الباك أند ولوحة التحكم

مجلد مستقل لخادم الترخيص ولوحة الإدارة. تطبيق الأندرويد يتصل به عبر:

`POST /api/verify-code`

---

## التشغيل المحلي

### 1) المتطلبات
- Node.js 18 أو أحدث
- MongoDB محلي، أو حساب مجاني على [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)

### 2) تثبيت الحزم
من مجلد `backend-dashboard`:

```bash
npm install
```

### 3) إعداد ملف البيئة
انسخ `.env.example` إلى `.env` (الملف موجود مسبقاً للتطوير المحلي) وعدّل القيم:

```
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/farz_licensing
SESSION_SECRET=ضع-مفتاحا-طويلا-وعشوائيا
ADMIN_USERNAME=admin
ADMIN_PASSWORD=كلمة-مرور-قوية
```

إذا كنت تستخدم Atlas ضع رابط الاتصال الكامل في `MONGODB_URI`.

### 4) تشغيل السيرفر

```bash
npm start
```

ثم افتح:

- لوحة التحكم: http://localhost:3000/admin
- فحص الصحة: http://localhost:3000/api/health

بيانات الدخول الافتراضية للتطوير: `admin` / `ChangeMe123!`

---

## ربط تطبيق الأندرويد

في جذر مشروع الأندرويد (وليس داخل `backend-dashboard`) أنشئ أو عدّل ملف `.env`:

```
LICENSE_API_BASE_URL=http://10.0.2.2:3000/
```

| الجهاز | قيمة `LICENSE_API_BASE_URL` |
|---|---|
| محاكي أندرويد | `http://10.0.2.2:3000/` |
| هاتف حقيقي على نفس الشبكة | `http://IP-الكمبيوتر:3000/` مثل `http://192.168.1.15:3000/` |
| بعد الرفع على Render | `https://your-service.onrender.com/` |

يجب أن ينتهي الرابط بشرطة `/`. بعد التعديل أعد بناء التطبيق (Rebuild).

على الهاتف الحقيقي تأكد أن جدار النار يسمح بالمنفذ 3000 وأن الكمبيوتر والهاتف على نفس الـ Wi-Fi.

---

## الرفع على Render (موصى به)

Vercel غير مناسب لهذا المشروع لأنه Serverless ولا يناسب Express + Sessions + MongoDB بشكل مستقر. استخدم Render:

1. ارفع المشروع إلى GitHub.
2. في [Render](https://render.com) أنشئ **Web Service**.
3. Root Directory: `backend-dashboard`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. أضف متغيرات البيئة:

```
NODE_ENV=production
MONGODB_URI=mongodb+srv://USER:PASS@cluster.mongodb.net/farz_licensing
SESSION_SECRET=مفتاح-عشوائي-طويل
ADMIN_USERNAME=admin
ADMIN_PASSWORD=كلمة-مرور-قوية-جدا
```

7. بعد النشر انسخ رابط الخدمة، مثال: `https://farz-licensing.onrender.com/`
8. ضعه في `.env` الخاص بالأندرويد:

```
LICENSE_API_BASE_URL=https://farz-licensing.onrender.com/
```

خطة Render المجانية قد تُنام بعد خمول؛ أول طلب بعد النوم يتأخر عدة ثوانٍ.

يمكن أيضاً استخدام الملف `render.yaml` عبر Blueprint.

---

## مسارات الـ API

### `POST /api/verify-code`

الجسم:

```json
{
  "code": "FARZ-XXXX-XXXX",
  "deviceId": "android-id",
  "mode": "activate"
}
```

`mode` يكون `activate` عند إدخال الكود، و `heartbeat` عند الفحص الدوري.

أمثلة الحالة `status`:

- `valid` — الكود ساري والجهاز مسموح
- `invalid` — الكود غير موجود
- `expired` — انتهت الصلاحية
- `blocked` — محظور من لوحة التحكم
- `device_mismatch` — الكود مرتبط بجهاز آخر
- `logged_out` — تم طرد الجهاز (Force Logout)

---

## لوحة التحكم

بعد تسجيل الدخول يمكنك:

- إنشاء أكواد جديدة بالمدة (أيام أو شهور)
- عرض الأكواد و Device ID المرتبط
- **حظر / تعطيل** الكود بالكامل
- **طرد الجهاز** لإجبار التطبيق على شاشة التفعيل في الفحص التالي
- حذف الكود

عند الحظر أو انتهاء الصلاحية أو الطرد يقوم تطبيق الأندرويد بمسح حالة التفعيل المحلية فوراً وإرجاع المستخدم لشاشة إدخال الكود.
