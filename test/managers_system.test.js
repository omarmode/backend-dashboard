process.env.NODE_ENV = "test";
process.env.ADMIN_USERNAME = "superadmin";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");

const { setSupabaseClientForTest } = require("../src/config/db");
const { createApp } = require("../server");
const { computeRemainingInfo } = require("../src/utils/codes");

/**
 * Isolated in-memory Supabase + Storage + PostgreSQL RPC simulator.
 * Guarantees ZERO writes or reads against production Supabase!
 */
function createMockSupabase() {
  const tables = {
    admin: [],
    managers: [],
    activation_codes: [],
    manager_files: []
  };
  const storageBuckets = {
    "manager-files": new Map()
  };

  function matchFilters(row, filters) {
    return filters.every(([col, val]) => String(row[col]) === String(val));
  }

  function clone(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  function makeQuery(tableName) {
    let op = "select";
    let insertPayload = null;
    let updatePayload = null;
    const filters = [];
    let orderSpec = null;
    let singleMode = null;

    const builder = {
      select() {
        return builder;
      },
      insert(payload) {
        op = "insert";
        insertPayload = payload;
        return builder;
      },
      update(payload) {
        op = "update";
        updatePayload = payload;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(col, val) {
        filters.push([col, val]);
        return builder;
      },
      order(col, { ascending = true } = {}) {
        orderSpec = { col, ascending };
        return builder;
      },
      single() {
        singleMode = "single";
        return builder;
      },
      maybeSingle() {
        singleMode = "maybeSingle";
        return builder;
      },
      then(resolve, reject) {
        try {
          const rows = tables[tableName];
          if (!rows) {
            return resolve({ data: null, error: { message: `Table ${tableName} not found` } });
          }

          if (op === "insert") {
            const list = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
            const inserted = [];
            for (const item of list) {
              // Enforce unique code constraint
              if (tableName === "activation_codes") {
                if (rows.some((r) => r.code === item.code)) {
                  return resolve({ data: null, error: { message: "duplicate key value violates unique constraint activation_codes_code_key" } });
                }
                // Enforce BEFORE INSERT quota trigger
                if (item.code_role === "manager_user") {
                  const mgr = tables.managers.find((m) => m.id === item.manager_id);
                  if (!mgr) {
                    return resolve({ data: null, error: { message: "MANAGER_NOT_FOUND" } });
                  }
                  const issued = rows.filter((r) => r.manager_id === item.manager_id && r.code_role === "manager_user").length;
                  if (issued >= mgr.max_users) {
                    return resolve({ data: null, error: { message: `QUOTA_EXCEEDED: max ${mgr.max_users}` } });
                  }
                }
                if (item.code_role === "manager") {
                  if (rows.some((r) => r.manager_id === item.manager_id && r.code_role === "manager")) {
                    return resolve({ data: null, error: { message: "activation_codes_one_manager_code_idx" } });
                  }
                }
              }
              const record = {
                id: item.id || crypto.randomUUID(),
                created_at: item.created_at || new Date().toISOString(),
                updated_at: item.updated_at || new Date().toISOString(),
                ...item
              };
              rows.push(record);
              inserted.push(clone(record));
            }
            const out = singleMode ? inserted[0] : inserted;
            return resolve({ data: out, error: null });
          }

          if (op === "update") {
            const updated = [];
            for (const row of rows) {
              if (matchFilters(row, filters)) {
                Object.assign(row, updatePayload);
                updated.push(clone(row));
              }
            }
            const out = singleMode ? (updated[0] || null) : updated;
            return resolve({ data: out, error: null });
          }

          if (op === "delete") {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (matchFilters(rows[i], filters)) {
                rows.splice(i, 1);
              }
            }
            return resolve({ data: null, error: null });
          }

          // select
          let matched = rows.filter((r) => matchFilters(r, filters)).map(clone);
          if (orderSpec) {
            matched.sort((a, b) => {
              const av = a[orderSpec.col] || "";
              const bv = b[orderSpec.col] || "";
              return orderSpec.ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
            });
          }

          if (singleMode === "single" || singleMode === "maybeSingle") {
            return resolve({ data: matched[0] || null, error: null });
          }
          return resolve({ data: matched, error: null });
        } catch (err) {
          return reject(err);
        }
      }
    };

    return builder;
  }

  return {
    tables,
    storageBuckets,
    from(tableName) {
      return makeQuery(tableName);
    },
    async rpc(fnName, params) {
      if (fnName === "update_manager_quota") {
        const mgr = tables.managers.find((m) => m.id === params.p_manager_id);
        if (!mgr) return { data: null, error: { message: "MANAGER_NOT_FOUND" } };
        const issued = tables.activation_codes.filter(
          (c) => c.manager_id === params.p_manager_id && c.code_role === "manager_user"
        ).length;
        if (params.p_new_max_users < issued) {
          return { data: null, error: { message: `QUOTA_BELOW_ISSUED: ${issued}` } };
        }
        mgr.max_users = params.p_new_max_users;
        mgr.updated_at = new Date().toISOString();
        return { data: clone(mgr), error: null };
      }

      if (fnName === "issue_manager_user_codes") {
        const mgr = tables.managers.find((m) => m.id === params.p_manager_id);
        if (!mgr) return { data: null, error: { message: "MANAGER_NOT_FOUND" } };
        const issued = tables.activation_codes.filter(
          (c) => c.manager_id === params.p_manager_id && c.code_role === "manager_user"
        ).length;
        if (issued + params.p_codes.length > mgr.max_users) {
          return { data: null, error: { message: "QUOTA_EXCEEDED" } };
        }
        const created = [];
        for (const item of params.p_codes) {
          if (tables.activation_codes.some((c) => c.code === item.code)) {
            return { data: null, error: { message: "duplicate code" } };
          }
          const rec = {
            id: crypto.randomUUID(),
            code: item.code,
            expires_at: item.expires_at,
            duration_days: item.duration_days,
            duration_label: item.duration_label,
            client_name: item.client_name,
            app_id: "FARZ_V2",
            code_role: "manager_user",
            manager_id: params.p_manager_id,
            created_by_admin_id: params.p_created_by_admin_id,
            is_active: false,
            is_blocked: false,
            device_id: null,
            activated_at: null,
            last_seen_at: null,
            created_at: new Date().toISOString()
          };
          tables.activation_codes.push(rec);
          created.push(clone(rec));
        }
        return { data: created, error: null };
      }

      return { data: null, error: { code: "PGRST202", message: `Function ${fnName} not found` } };
    },
    storage: {
      from(bucket) {
        if (!storageBuckets[bucket]) storageBuckets[bucket] = new Map();
        const store = storageBuckets[bucket];
        return {
          async upload(storagePath, bodyOrStream) {
            let buf;
            if (Buffer.isBuffer(bodyOrStream)) {
              buf = Buffer.from(bodyOrStream);
            } else if (bodyOrStream && typeof bodyOrStream[Symbol.asyncIterator] === "function") {
              const parts = [];
              for await (const chunk of bodyOrStream) {
                parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              buf = Buffer.concat(parts);
            } else {
              buf = Buffer.from(bodyOrStream || "");
            }
            store.set(storagePath, {
              bytes: buf,
              createdAt: new Date().toISOString(),
              etag: crypto.createHash("md5").update(buf).digest("hex")
            });
            return { data: { path: storagePath }, error: null };
          },
          async createSignedUploadUrl(storagePath, opts = {}) {
            const token = `signed-tus-tok-${crypto.randomBytes(12).toString("hex")}`;
            return {
              data: {
                signedUrl: `https://test-ref.supabase.co/storage/v1/object/upload/sign/${bucket}/${storagePath}?token=${token}`,
                path: storagePath,
                token,
                upsert: Boolean(opts.upsert)
              },
              error: null
            };
          },
          async createSignedUrl(storagePath, expiresIn) {
            if (!store.has(storagePath)) {
              return { data: null, error: { message: "Object not found" } };
            }
            return {
              data: {
                signedUrl: `https://test-ref.storage.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?token=dl-${crypto.randomBytes(8).toString("hex")}&exp=${expiresIn}`
              },
              error: null
            };
          },
          async info(storagePath) {
            const entry = store.get(storagePath);
            if (!entry) return { data: null, error: { statusCode: 404, message: "Object not found" } };
            return {
              data: {
                size: entry.bytes.length,
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                etag: entry.etag,
                lastModified: entry.createdAt
              },
              error: null
            };
          },
          async downloadRange(storagePath, start, end) {
            const entry = store.get(storagePath);
            if (!entry) return { data: null, error: { message: "Object not found" } };
            return { data: entry.bytes.subarray(start, end + 1), error: null };
          },
          async list(prefix = "") {
            const normPrefix = prefix ? `${prefix.replace(/\/+$/, "")}/` : "";
            const items = [];
            for (const [k, v] of store.entries()) {
              if (!normPrefix || k.startsWith(normPrefix)) {
                const name = normPrefix ? k.slice(normPrefix.length) : k;
                if (!name.includes("/")) {
                  items.push({
                    name,
                    created_at: v.createdAt,
                    updated_at: v.createdAt,
                    metadata: { size: v.bytes.length, eTag: v.etag }
                  });
                }
              }
            }
            return { data: items, error: null };
          },
          async download(storagePath) {
            const entry = store.get(storagePath);
            if (!entry) return { data: null, error: { message: "Object not found" } };
            return { data: Buffer.from(entry.bytes), error: null };
          },
          async remove(paths) {
            for (const p of paths) store.delete(p);
            return { data: [], error: null };
          }
        };
      }
    }
  };
}

function makeSampleXlsxBuffer(rows = [["اللوحة", "المالك"], ["ا ب ج 1234", "أحمد"], ["س ص ع 5678", "محمد"]]) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function buildMultipartBody(fieldName, fileName, fileBuffer, extraFields = {}) {
  const boundary = "----FarzonTestBoundary" + crypto.randomBytes(6).toString("hex");
  const chunks = [];
  for (const [k, v] of Object.entries(extraFields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
    )
  );
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks)
  };
}

function httpRequest(port, method, reqPath, { headers = {}, body = null, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders.Cookie = cookie;
    let payload = body;
    if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
      if (reqHeaders["Content-Type"] === "application/x-www-form-urlencoded") {
        payload = new URLSearchParams(body).toString();
      } else {
        reqHeaders["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    if (payload) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request({ hostname: "127.0.0.1", port, path: reqPath, method, headers: reqHeaders }, (res) => {
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(bufs);
        let json = null;
        try {
          json = JSON.parse(raw.toString("utf8"));
        } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          text: raw.toString("utf8"),
          json,
          setCookie: res.headers["set-cookie"] ? res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ") : null
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("Farzon Full Managers, Expiration, Quotas, Isolation & Files Suite", async (t) => {
  const mockDb = createMockSupabase();
  setSupabaseClientForTest(mockDb);

  // Seed Super Admin + legacy Web Sub-Admin (to confirm sub-admin is blocked from web login & code creation)
  const superHash = await bcrypt.hash("SuperPass123!", 10);
  const legacySubHash = await bcrypt.hash("LegacySub123!", 10);
  const superAdminId = crypto.randomUUID();
  mockDb.tables.admin.push(
    { id: superAdminId, username: "superadmin", password: superHash, role: "super_admin", is_active: true, created_at: new Date().toISOString() },
    { id: crypto.randomUUID(), username: "legacy_sub", password: legacySubHash, role: "sub_admin", is_active: true, created_at: new Date().toISOString() }
  );

  // Seed a legacy pre-upgrade regular FARZON code (missing code_role & manager_id) + a Tab 1 FARZ_V1 code
  const future30 = new Date(Date.now() + 30 * 86400000).toISOString();
  const past2 = new Date(Date.now() - 2 * 86400000).toISOString();
  mockDb.tables.activation_codes.push(
    {
      id: crypto.randomUUID(),
      code: "FARZON-OLD1-0001",
      app_id: "FARZ_V2",
      expires_at: future30,
      is_active: false,
      is_blocked: false,
      device_id: null,
      client_name: "Legacy Regular User",
      created_at: new Date().toISOString()
    },
    {
      id: crypto.randomUUID(),
      code: "FARZ-TAB1-0001",
      app_id: "FARZ_V1",
      expires_at: future30,
      is_active: false,
      is_blocked: false,
      device_id: null,
      client_name: "Tab 1 App User",
      created_at: new Date().toISOString()
    },
    {
      id: crypto.randomUUID(),
      code: "FARZON-EXP1-0001",
      app_id: "FARZ_V2",
      code_role: "regular",
      manager_id: null,
      expires_at: past2,
      is_active: true,
      is_blocked: false,
      device_id: "dev-expired-reg",
      client_name: "Expired Regular",
      created_at: new Date(Date.now() - 32 * 86400000).toISOString()
    }
  );

  const app = createApp({ sessionSecret: "test-secret" });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  t.after(() => server.close());

  let superCookie = null;

  await t.test("1. Only Super Admin can log in to dashboard; legacy sub_admin is blocked", async () => {
    // Legacy sub-admin login attempt must be rejected
    const badLogin = await httpRequest(port, "POST", "/admin/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { username: "legacy_sub", password: "LegacySub123!" }
    });
    assert.equal(badLogin.status, 302);
    assert.equal(badLogin.headers.location, "/admin/login");

    // Super Admin login succeeds
    const goodLogin = await httpRequest(port, "POST", "/admin/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { username: "superadmin", password: "SuperPass123!" }
    });
    assert.equal(goodLogin.status, 302);
    assert.equal(goodLogin.headers.location, "/admin");
    superCookie = goodLogin.setCookie;
    assert.ok(superCookie);

    // Unauthenticated attempt to create codes/managers must fail
    const unauth = await httpRequest(port, "POST", "/admin/managers", {
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: { name: "Hacker", max_users: "10", manager_duration_days: "30" }
    });
    assert.equal(unauth.status, 401);
  });

  await t.test("2. Tab 1 (FARZ_V1) works independently and rejects Farzon cross-use", async () => {
    const okV1 = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: "FARZ-TAB1-0001", deviceId: "dev-v1-1", mode: "activate", app_id: "FARZ_V1" }
    });
    assert.equal(okV1.status, 200);
    assert.equal(okV1.json.success, true);
    assert.equal(okV1.json.role, "regular");

    const mismatch = await httpRequest(port, "POST", "/api/farzon/register", {
      body: { code: "FARZ-TAB1-0001", deviceId: "dev-v1-1" }
    });
    assert.equal(mismatch.json.success, false);
    assert.equal(mismatch.json.status, "app_mismatch");
  });

  let regularCode30 = null;

  await t.test("3. Tab 2 regular user (30d) + legacy pre-upgrade regular code work with zero manager access", async () => {
    // Super Admin creates regular 30d Farzon code
    const createRes = await httpRequest(port, "POST", "/admin/codes", {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { app_id: "FARZ_V2", client_name: "Regular 30d", durationValue: "30", durationUnit: "days" }
    });
    assert.equal(createRes.status, 302);

    const createdRow = mockDb.tables.activation_codes.find((c) => c.client_name === "Regular 30d");
    assert.ok(createdRow);
    assert.equal(createdRow.code_role, "regular");
    assert.equal(createdRow.manager_id, null);
    assert.equal(createdRow.duration_days, 30);
    regularCode30 = createdRow.code;

    // Activate new regular 30d code
    const actNew = await httpRequest(port, "POST", "/api/farzon/register", {
      body: { code: regularCode30, deviceId: "dev-reg-30" }
    });
    assert.equal(actNew.json.success, true);
    assert.equal(actNew.json.role, "regular");
    assert.equal(actNew.json.managerId, null);
    assert.equal(actNew.json.isSubAdminClient, false);
    assert.ok(actNew.json.serverTime);

    // Activate legacy pre-upgrade regular code
    const actLegacy = await httpRequest(port, "POST", "/api/farzon/register", {
      body: { code: "FARZON-OLD1-0001", deviceId: "dev-reg-old" }
    });
    assert.equal(actLegacy.json.success, true);
    assert.equal(actLegacy.json.role, "regular");
    assert.equal(actLegacy.json.managerId, null);

    // Regular user CANNOT access manager files or upload
    const forbidList = await httpRequest(port, "POST", "/api/farzon/my-data-files", {
      body: { code: regularCode30, deviceId: "dev-reg-30" }
    });
    assert.equal(forbidList.status, 403);

    const forbidMgr = await httpRequest(port, "POST", "/api/farzon/manager/files/list", {
      body: { code: regularCode30, deviceId: "dev-reg-30" }
    });
    assert.equal(forbidMgr.status, 403);

    // Expired regular code is blocked
    const expReg = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: "FARZON-EXP1-0001", deviceId: "dev-expired-reg", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(expReg.json.success, false);
    assert.equal(expReg.json.status, "expired");
  });

  let mgrAhmedId, mgrAhmedCode, ahmedUser30Code, ahmedUser90Code;
  let mgrMohamedId, mgrMohamedCode, mohamedUserCode;

  await t.test("4. Create 3 independent managers with different quotas & independent per-code durations", async () => {
    // Manager Ahmed: 365 days, quota 2 (for fast quota exhaustion test), with 2 users having 30d and 90d!
    const r1 = await httpRequest(port, "POST", "/admin/managers", {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: {
        name: "المدير أحمد",
        max_users: "2",
        manager_duration_days: "365",
        initial_users_count: "0",
        custom_user_durations: "30, 90"
      }
    });
    assert.equal(r1.status, 302);

    // Manager Mohamed: 180 days, quota 25, 1 user with 60d
    const r2 = await httpRequest(port, "POST", "/admin/managers", {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: {
        name: "المدير محمد",
        max_users: "25",
        manager_duration_days: "180",
        initial_users_count: "1",
        users_duration_days: "60"
      }
    });
    assert.equal(r2.status, 302);

    // Manager Mahmoud: 90 days, quota 50, 0 initial users
    const r3 = await httpRequest(port, "POST", "/admin/managers", {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: {
        name: "المدير محمود",
        max_users: "50",
        manager_duration_days: "90",
        initial_users_count: "0"
      }
    });
    assert.equal(r3.status, 302);

    assert.equal(mockDb.tables.managers.length, 3);
    const ahmed = mockDb.tables.managers.find((m) => m.name === "المدير أحمد");
    const mohamed = mockDb.tables.managers.find((m) => m.name === "المدير محمد");
    mgrAhmedId = ahmed.id;
    mgrMohamedId = mohamed.id;

    const ahmedMgrRow = mockDb.tables.activation_codes.find((c) => c.manager_id === mgrAhmedId && c.code_role === "manager");
    const ahmedUsers = mockDb.tables.activation_codes.filter((c) => c.manager_id === mgrAhmedId && c.code_role === "manager_user");
    assert.equal(ahmedMgrRow.duration_days, 365);
    assert.equal(ahmedUsers.length, 2);
    assert.deepEqual(ahmedUsers.map((u) => u.duration_days).sort((a, b) => a - b), [30, 90]);
    mgrAhmedCode = ahmedMgrRow.code;
    ahmedUser30Code = ahmedUsers.find((u) => u.duration_days === 30).code;
    ahmedUser90Code = ahmedUsers.find((u) => u.duration_days === 90).code;

    const mohamedMgrRow = mockDb.tables.activation_codes.find((c) => c.manager_id === mgrMohamedId && c.code_role === "manager");
    const mohamedUserRow = mockDb.tables.activation_codes.find((c) => c.manager_id === mgrMohamedId && c.code_role === "manager_user");
    mgrMohamedCode = mohamedMgrRow.code;
    mohamedUserCode = mohamedUserRow.code;

    // Tab 2 dashboard HTML must NOT show manager or manager_user codes!
    const tab2Html = await httpRequest(port, "GET", "/admin?tab=FARZ_V2", { cookie: superCookie });
    assert.equal(tab2Html.status, 200);
    assert.ok(tab2Html.text.includes(regularCode30));
    const tab2PanelOnly = tab2Html.text.split("<!-- TAB 3:")[0];
    assert.ok(!tab2PanelOnly.includes(mgrAhmedCode), "Manager code leaked into Tab 2");
    assert.ok(!tab2PanelOnly.includes(ahmedUser30Code), "Manager user code leaked into Tab 2");
  });

  await t.test("5. Quota enforcement: block exceeding quota, block reducing below issued, allow after increase & concurrent race test", async () => {
    // Ahmed already has 2/2 issued -> attempting 3rd code must NOT insert
    await httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/codes`, {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { count: "1", duration_days: "30" }
    });
    const countAfterExceed = mockDb.tables.activation_codes.filter((c) => c.manager_id === mgrAhmedId && c.code_role === "manager_user").length;
    assert.equal(countAfterExceed, 2);

    // Reducing quota below 2 (to 1) must be rejected without deleting issued codes
    await httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/quota`, {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { max_users: "1" }
    });
    assert.equal(mockDb.tables.managers.find((m) => m.id === mgrAhmedId).max_users, 2);

    // Increasing quota to 3 leaves exactly 1 slot -> fire 2 CONCURRENT requests, only 1 must succeed!
    await httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/quota`, {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { max_users: "3" }
    });
    assert.equal(mockDb.tables.managers.find((m) => m.id === mgrAhmedId).max_users, 3);

    await Promise.all([
      httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/codes`, {
        cookie: superCookie,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: { count: "1", duration_days: "45" }
      }),
      httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/codes`, {
        cookie: superCookie,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: { count: "1", duration_days: "45" }
      })
    ]);
    const finalCount = mockDb.tables.activation_codes.filter((c) => c.manager_id === mgrAhmedId && c.code_role === "manager_user").length;
    assert.equal(finalCount, 3, "Concurrent requests exceeded manager quota!");
  });

  let ahmedFile1Id, ahmedFile2Id;

  await t.test("6. Manager activates in app, uploads 2 Excel files, cross-group isolation & GET download blocked", async () => {
    // Activate Manager Ahmed & Manager Mohamed & Users
    const actMgrA = await httpRequest(port, "POST", "/api/farzon/register", { body: { code: mgrAhmedCode, deviceId: "dev-mgr-ahmed" } });
    assert.equal(actMgrA.json.success, true);
    assert.equal(actMgrA.json.role, "manager");
    assert.equal(actMgrA.json.durationDays, 365);

    const actUserA30 = await httpRequest(port, "POST", "/api/farzon/register", { body: { code: ahmedUser30Code, deviceId: "dev-user-a30" } });
    assert.equal(actUserA30.json.success, true);
    assert.equal(actUserA30.json.role, "manager_user");
    assert.equal(actUserA30.json.durationDays, 30);

    const actUserA90 = await httpRequest(port, "POST", "/api/farzon/register", { body: { code: ahmedUser90Code, deviceId: "dev-user-a90" } });
    assert.equal(actUserA90.json.success, true);
    assert.equal(actUserA90.json.durationDays, 90);

    await httpRequest(port, "POST", "/api/farzon/register", { body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed" } });
    await httpRequest(port, "POST", "/api/farzon/register", { body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" } });

    // Manager Ahmed uploads 2 valid Excel files from Android app
    const xlsx1 = makeSampleXlsxBuffer([["اللوحة", "العميل"], ["ا ب ج 1111", "أحمد 1"]]);
    const xlsx2 = makeSampleXlsxBuffer([["اللوحة", "العميل"], ["د ه و 2222", "أحمد 2"]]);

    const mp1 = buildMultipartBody("file", "ahmed_file_1.xlsx", xlsx1);
    const up1 = await httpRequest(port, "POST", "/api/farzon/manager/files/upload", {
      headers: {
        "Content-Type": mp1.contentType,
        "X-License-Code": mgrAhmedCode,
        "X-Device-Id": "dev-mgr-ahmed",
        "X-File-Name": encodeURIComponent("بيانات_أحمد_1.xlsx")
      },
      body: mp1.body
    });
    assert.equal(up1.status, 201);
    assert.equal(up1.json.success, true);
    assert.equal(up1.json.file.fileName, "بيانات_أحمد_1.xlsx");
    ahmedFile1Id = up1.json.file.id;

    const mp2 = buildMultipartBody("file", "ahmed_file_2.xlsx", xlsx2);
    const up2 = await httpRequest(port, "POST", "/api/farzon/manager/files/upload", {
      headers: {
        "Content-Type": mp2.contentType,
        "X-License-Code": mgrAhmedCode,
        "X-Device-Id": "dev-mgr-ahmed"
      },
      body: mp2.body
    });
    assert.equal(up2.status, 201);
    assert.equal(up2.json.filesCount, 2);
    ahmedFile2Id = up2.json.file.id;

    // Invalid file disguised as .xlsx must be rejected by magic bytes check
    const fakeMp = buildMultipartBody("file", "evil.xlsx", Buffer.from("NOT_A_ZIP_OR_EXCEL"));
    const fakeUp = await httpRequest(port, "POST", "/api/farzon/manager/files/upload", {
      headers: { "Content-Type": fakeMp.contentType, "X-License-Code": mgrAhmedCode, "X-Device-Id": "dev-mgr-ahmed" },
      body: fakeMp.body
    });
    assert.equal(fakeUp.status, 400);

    // Manager user CANNOT upload files
    const userUp = await httpRequest(port, "POST", "/api/farzon/manager/files/upload", {
      headers: { "Content-Type": mp1.contentType, "X-License-Code": ahmedUser30Code, "X-Device-Id": "dev-user-a30" },
      body: mp1.body
    });
    assert.equal(userUp.status, 403);

    // Ahmed's user sees both files and can download via POST
    const listA = await httpRequest(port, "POST", "/api/farzon/my-data-files", {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30" }
    });
    assert.equal(listA.status, 200);
    assert.equal(listA.json.files.length, 2);

    const dlA = await httpRequest(port, "POST", `/api/farzon/files/${ahmedFile1Id}/download`, {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30" }
    });
    assert.equal(dlA.status, 200);
    assert.ok(dlA.raw.equals(xlsx1));

    // Insecure GET download with query string is rejected (405)
    const getDl = await httpRequest(port, "GET", `/api/farzon/files/${ahmedFile1Id}/download?code=${ahmedUser30Code}&deviceId=dev-user-a30`);
    assert.equal(getDl.status, 405);

    // Cross-group isolation: Mohamed's user CANNOT download Ahmed's fileId!
    const crossDl = await httpRequest(port, "POST", `/api/farzon/files/${ahmedFile1Id}/download`, {
      body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" }
    });
    assert.equal(crossDl.status, 403);

    // Cross-group isolation: Manager Mohamed CANNOT delete Ahmed's file!
    const crossDel = await httpRequest(port, "POST", `/api/farzon/manager/files/${ahmedFile1Id}/delete`, {
      body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed" }
    });
    assert.equal(crossDel.status, 403);
  });

  await t.test("7. Manager deletes file -> sync revokes deleted file while keeping other file", async () => {
    const delRes = await httpRequest(port, "POST", `/api/farzon/manager/files/${ahmedFile1Id}/delete`, {
      body: { code: mgrAhmedCode, deviceId: "dev-mgr-ahmed" }
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.filesCount, 1);

    // Downloading deleted file now returns 404
    const dlDeleted = await httpRequest(port, "POST", `/api/farzon/files/${ahmedFile1Id}/download`, {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30" }
    });
    assert.equal(dlDeleted.status, 404);

    // Sync reports ahmedFile1Id in revokedFileIds and ahmedFile2Id in activeFiles
    const syncRes = await httpRequest(port, "POST", "/api/farzon/sync-files", {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30", localFileIds: [ahmedFile1Id, ahmedFile2Id] }
    });
    assert.equal(syncRes.status, 200);
    assert.deepEqual(syncRes.json.revokedFileIds, [ahmedFile1Id]);
    assert.equal(syncRes.json.activeFiles.length, 1);
    assert.equal(syncRes.json.activeFiles[0].id, ahmedFile2Id);
  });

  await t.test("8. manager_license_expired vs manager_group_disabled strict separation", async () => {
    // Expire Manager Ahmed's own code ONLY (group stays active!)
    const ahmedMgrRow = mockDb.tables.activation_codes.find((c) => c.code === mgrAhmedCode);
    ahmedMgrRow.expires_at = new Date(Date.now() - 3600000).toISOString();

    // Manager Ahmed gets manager_license_expired and cannot upload
    const mgrHb = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: mgrAhmedCode, deviceId: "dev-mgr-ahmed", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(mgrHb.json.success, false);
    assert.equal(mgrHb.json.status, "expired");
    assert.equal(mgrHb.json.reason, "manager_license_expired");

    // Ahmed's user (still valid 30d) is NOT expired and STILL gets group files while group is active!
    const userHb = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(userHb.json.success, true);
    assert.equal(userHb.json.status, "valid");
    assert.equal(userHb.json.managerActive, true);
    assert.equal(userHb.json.filesCount, 1);

    // Super Admin extends Manager Ahmed's code by 60 days -> device binding stays intact!
    await httpRequest(port, "POST", `/admin/codes/${ahmedMgrRow.id}/extend`, {
      cookie: superCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: { days: "60" }
    });
    assert.equal(ahmedMgrRow.device_id, "dev-mgr-ahmed");
    assert.equal(ahmedMgrRow.is_active, true);
    const mgrHbAfterExtend = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: mgrAhmedCode, deviceId: "dev-mgr-ahmed", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(mgrHbAfterExtend.json.success, true);

    // Now Super Admin DISABLES Manager Ahmed's group (manager_group_disabled)
    await httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/toggle`, { cookie: superCookie });

    // Manager Ahmed is blocked with manager_group_disabled
    const mgrDisabled = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: mgrAhmedCode, deviceId: "dev-mgr-ahmed", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(mgrDisabled.json.success, false);
    assert.equal(mgrDisabled.json.reason, "manager_group_disabled");

    // User's own license stays valid (personal files remain usable) BUT group files are blocked & purged!
    const userWithDisabledGroup = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(userWithDisabledGroup.json.success, true);
    assert.equal(userWithDisabledGroup.json.managerActive, false);
    assert.equal(userWithDisabledGroup.json.groupStatus, "manager_group_disabled");

    const syncDisabled = await httpRequest(port, "POST", "/api/farzon/sync-files", {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30", localFileIds: [ahmedFile2Id] }
    });
    assert.equal(syncDisabled.json.shouldPurgeAll, true);
    assert.equal(syncDisabled.json.reason, "manager_group_disabled");
    assert.deepEqual(syncDisabled.json.revokedFileIds, [ahmedFile2Id]);

    const dlDisabled = await httpRequest(port, "POST", `/api/farzon/files/${ahmedFile2Id}/download`, {
      body: { code: ahmedUser30Code, deviceId: "dev-user-a30" }
    });
    assert.equal(dlDisabled.status, 403);
    assert.equal(dlDisabled.json.reason, "manager_group_disabled");
  });

  await t.test("9. Edge cases: less than 1 day remaining, past expiry, device mismatch & force logout", async () => {
    const now = new Date("2026-11-23T10:00:00.000Z");
    const in5Hours = new Date("2026-11-23T15:00:00.000Z");
    const remLessDay = computeRemainingInfo(in5Hours, now);
    assert.equal(remLessDay.expired, false);
    assert.equal(remLessDay.lessThanOneDay, true);
    assert.ok(remLessDay.labelAr.includes("متبقي أقل من يوم"));

    const pastDate = new Date("2026-11-20T00:00:00.000Z");
    const remPast = computeRemainingInfo(pastDate, now);
    assert.equal(remPast.expired, true);

    // Device mismatch on regular code
    const wrongDev = await httpRequest(port, "POST", "/api/farzon/register", {
      body: { code: regularCode30, deviceId: "another-device-xyz" }
    });
    assert.equal(wrongDev.json.success, false);
    assert.equal(wrongDev.json.status, "device_mismatch");

    // Force logout from dashboard
    const regRow = mockDb.tables.activation_codes.find((c) => c.code === regularCode30);
    await httpRequest(port, "POST", `/admin/codes/${regRow.id}/force-logout`, { cookie: superCookie });
    const hbAfterLogout = await httpRequest(port, "POST", "/api/verify-code", {
      body: { code: regularCode30, deviceId: "dev-reg-30", mode: "heartbeat", app_id: "FARZON" }
    });
    assert.equal(hbAfterLogout.json.success, false);
    assert.equal(hbAfterLogout.json.status, "logged_out");
  });

  await t.test("10. Final Correction: Super Admin has zero file access (HTML + 403 APIs), multi-file upload/single delete, duplicate names & local-delete re-download", async () => {
    // Manager Mohamed uploads 3 files sequentially (Data_1.xlsx, Data_2.xlsx, Data_3.xlsx)
    const buf1 = makeSampleXlsxBuffer([["اللوحة", "المالك"], ["ر ت ث 1001", "عميل 1"]]);
    const buf2 = makeSampleXlsxBuffer([["اللوحة", "المالك"], ["ج ح خ 2002", "عميل 2"]]);
    const buf3 = makeSampleXlsxBuffer([["اللوحة", "المالك"], ["د ذ ر 3003", "عميل 3"]]);

    const uploadFile = async (name, buffer) => {
      const mp = buildMultipartBody("file", name, buffer);
      return httpRequest(port, "POST", "/api/farzon/manager/files/upload", {
        headers: {
          "Content-Type": mp.contentType,
          "X-License-Code": mgrMohamedCode,
          "X-Device-Id": "dev-mgr-mohamed",
          "X-File-Name": encodeURIComponent(name)
        },
        body: mp.body
      });
    };

    const u1 = await uploadFile("Data_1.xlsx", buf1);
    const u2 = await uploadFile("Data_2.xlsx", buf2);
    const u3 = await uploadFile("Data_3.xlsx", buf3);
    assert.equal(u1.status, 201);
    assert.equal(u2.status, 201);
    assert.equal(u3.status, 201);
    assert.equal(u3.json.filesCount, 3);

    // Upload a duplicate filename Data_1.xlsx -> gets its own unique UUID without colliding
    const buf1Copy = makeSampleXlsxBuffer([["اللوحة", "المالك"], ["ز س ش 4004", "عميل 4"]]);
    const u1Dup = await uploadFile("Data_1.xlsx", buf1Copy);
    assert.equal(u1Dup.status, 201);
    assert.notEqual(u1Dup.json.file.id, u1.json.file.id);
    assert.equal(u1Dup.json.file.fileName, "Data_1.xlsx");
    assert.equal(u1Dup.json.filesCount, 4);

    // Super Admin dashboard HTML MUST NOT display ANY manager file names, counts, or file actions!
    const mgrTabHtml = await httpRequest(port, "GET", `/admin?tab=MANAGERS&manager=${mgrMohamedId}`, {
      cookie: superCookie
    });
    assert.equal(mgrTabHtml.status, 200);
    assert.ok(!mgrTabHtml.text.includes("Data_1.xlsx"), "Super Admin HTML leaked manager file Data_1.xlsx");
    assert.ok(!mgrTabHtml.text.includes("Data_2.xlsx"), "Super Admin HTML leaked manager file Data_2.xlsx");
    assert.ok(!mgrTabHtml.text.includes("Data_3.xlsx"), "Super Admin HTML leaked manager file Data_3.xlsx");
    assert.ok(!mgrTabHtml.text.includes("ahmed_file_2.xlsx"), "Super Admin HTML leaked ahmed_file_2.xlsx");
    assert.ok(!mgrTabHtml.text.includes("الملفات المرفوعة من تطبيق المدير"), "Super Admin HTML still shows files section");
    assert.ok(!mgrTabHtml.text.includes("/files/"), "Super Admin HTML still renders file action URLs");

    // Server-side 403 block on ALL Super Admin file routes
    const blockGetFiles = await httpRequest(port, "GET", "/admin/files", { cookie: superCookie });
    assert.equal(blockGetFiles.status, 403);
    assert.equal(blockGetFiles.json.status, "forbidden_super_admin_files");

    const blockMgrFilesList = await httpRequest(port, "GET", `/admin/managers/${mgrMohamedId}/files`, {
      cookie: superCookie
    });
    assert.equal(blockMgrFilesList.status, 403);

    const blockMgrFileDelete = await httpRequest(
      port,
      "POST",
      `/admin/managers/${mgrMohamedId}/files/${u1.json.file.id}/delete`,
      { cookie: superCookie }
    );
    assert.equal(blockMgrFileDelete.status, 403);
    assert.equal(blockMgrFileDelete.json.status, "forbidden_super_admin_files");

    // Manager deletes ONLY Data_2.xlsx -> Data_1.xlsx (both copies) and Data_3.xlsx remain intact!
    const del2 = await httpRequest(port, "POST", `/api/farzon/manager/files/${u2.json.file.id}/delete`, {
      body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed" }
    });
    assert.equal(del2.status, 200);
    assert.equal(del2.json.filesCount, 3);

    // Manager deletes ONLY the duplicate Data_1.xlsx -> original Data_1.xlsx + Data_3.xlsx stay intact!
    const delDup = await httpRequest(port, "POST", `/api/farzon/manager/files/${u1Dup.json.file.id}/delete`, {
      body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed" }
    });
    assert.equal(delDup.status, 200);
    assert.equal(delDup.json.filesCount, 2);

    // Manager-user downloads Data_1.xlsx, deletes local copy (does not call server delete), then re-downloads it!
    const userList = await httpRequest(port, "POST", "/api/farzon/my-data-files", {
      body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" }
    });
    assert.equal(userList.status, 200);
    const remainingNames = userList.json.files.map((f) => f.fileName).sort();
    assert.deepEqual(remainingNames, ["Data_1.xlsx", "Data_3.xlsx"]);

    const dl1 = await httpRequest(port, "POST", `/api/farzon/files/${u1.json.file.id}/download`, {
      body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" }
    });
    assert.equal(dl1.status, 200);
    assert.ok(dl1.raw.equals(buf1));

    // Re-download after user deleted local copy on their phone
    const dl1Again = await httpRequest(port, "POST", `/api/farzon/files/${u1.json.file.id}/download`, {
      body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" }
    });
    assert.equal(dl1Again.status, 200);
    assert.ok(dl1Again.raw.equals(buf1));

    // Manager-user CANNOT delete manager file on server (403)
    const userTryServerDel = await httpRequest(port, "POST", `/api/farzon/manager/files/${u1.json.file.id}/delete`, {
      body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" }
    });
    assert.equal(userTryServerDel.status, 403);

    // Regular user CANNOT upload to manager server (403)
    const regMp = buildMultipartBody("file", "personal.xlsx", buf1);
    const regTryUp = await httpRequest(port, "POST", "/api/farzon/manager/files/upload", {
      headers: { "Content-Type": regMp.contentType, "X-License-Code": "FARZON-OLD1-0001", "X-Device-Id": "dev-reg-old" },
      body: regMp.body
    });
    assert.equal(regTryUp.status, 403);
  });

  await t.test("11. Solution C Direct Signed TUS Upload (40 MB zero-Render-RAM), Token Refresh, Idempotent Complete, Signed Download URL & Isolation", async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const prevAnonKey = process.env.SUPABASE_ANON_KEY;
    process.env.SUPABASE_URL = "https://khiptabndxlmfltrvkfh.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret-service-role-never-expose";
    process.env.SUPABASE_ANON_KEY = "test-public-anon-key";

    try {
      const size40MB = 40 * 1024 * 1024;
      const fake40Hash = crypto.createHash("sha256").update("synthetic-40mb-marker").digest("hex");

      // 11a. Regular & Manager-User CANNOT call /upload/init (403)
      const userInitBlocked = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/init", {
        body: { code: mohamedUserCode, deviceId: "dev-user-mohamed", fileName: "blocked.xlsx", fileSize: 1024 }
      });
      assert.equal(userInitBlocked.status, 403);

      // 11b. > 50 MB is rejected immediately at /upload/init with HTTP 413 and exact limit message
      const over50 = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/init", {
        body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed", fileName: "huge_55mb.xlsx", fileSize: 55 * 1024 * 1024 }
      });
      assert.equal(over50.status, 413);
      assert.equal(over50.json.status, "file_too_large");
      assert.equal(over50.json.maxFileSizeMb, 50);

      // 11c. Manager initializes 40 MB Signed TUS upload (JSON-only metadata -> zero bytes in Render RAM!)
      const init40 = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/init", {
        body: {
          code: mgrMohamedCode,
          deviceId: "dev-mgr-mohamed",
          fileName: "ملف_كبير_40ميجا.xlsx",
          fileSize: size40MB,
          fileHash: fake40Hash,
          recordsCount: 500747
        }
      });
      assert.equal(init40.status, 200);
      assert.equal(init40.json.success, true);
      assert.equal(init40.json.chunkSizeBytes, 6 * 1024 * 1024);
      assert.equal(init40.json.tusEndpoint, "https://khiptabndxlmfltrvkfh.storage.supabase.co/storage/v1/upload/resumable/sign");
      assert.ok(init40.json.tusHeaders["x-signature"].startsWith("signed-tus-tok-"));
      assert.equal(init40.json.tusHeaders.apikey, "test-public-anon-key");
      // Security: service_role key MUST NEVER appear anywhere in init response!
      assert.ok(!init40.text.includes("test-secret-service-role-never-expose"));
      assert.ok(init40.json.storagePath.startsWith(`managers/${mgrMohamedId}/`));

      // 11d. Completing BEFORE object is uploaded to Supabase Storage MUST fail (409 upload_incomplete)
      // and file MUST NOT be visible to manager_user yet!
      const prematureComplete = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/complete", {
        body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed", uploadSessionToken: init40.json.uploadSessionToken }
      });
      assert.equal(prematureComplete.status, 409);
      assert.equal(prematureComplete.json.status, "upload_incomplete");

      // 11e. Token Refresh mid-upload re-issues a fresh x-signature for the EXACT same fileId & storagePath
      const refreshed = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/init", {
        body: {
          code: mgrMohamedCode,
          deviceId: "dev-mgr-mohamed",
          uploadSessionToken: init40.json.uploadSessionToken
        }
      });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.json.refreshed, true);
      assert.equal(refreshed.json.fileId, init40.json.fileId);
      assert.equal(refreshed.json.storagePath, init40.json.storagePath);
      assert.notEqual(refreshed.json.tusToken, init40.json.tusToken);

      // 11f. Simulate Direct Supabase TUS completing a 40 MB valid XLSX object (PK\x03\x04 header + 40 MB size)
      // without passing those 40 MB through Express/Render!
      const validZipHead = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
      const virtual40Entry = {
        bytes: {
          length: size40MB,
          subarray: (s, e) => validZipHead.subarray(s, Math.min(e, validZipHead.length))
        },
        createdAt: new Date().toISOString(),
        etag: "etag-40mb-verified"
      };
      mockDb.storageBuckets["manager-files"].set(init40.json.storagePath, virtual40Entry);

      // Cross-manager complete attempt MUST be blocked (403)
      // Re-enable Manager Ahmed briefly to test cross-manager session hijack rejection
      await httpRequest(port, "POST", `/admin/managers/${mgrAhmedId}/toggle`, { cookie: superCookie });
      const hijackComplete = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/complete", {
        body: { code: mgrAhmedCode, deviceId: "dev-mgr-ahmed", uploadSessionToken: init40.json.uploadSessionToken }
      });
      assert.equal(hijackComplete.status, 403);
      assert.equal(hijackComplete.json.status, "forbidden_group");

      // 11g. Legitimate Manager completes the 40 MB upload -> 201 Created
      const complete1 = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/complete", {
        body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed", uploadSessionToken: init40.json.uploadSessionToken }
      });
      assert.equal(complete1.status, 201);
      assert.equal(complete1.json.success, true);
      assert.equal(complete1.json.alreadyCompleted, false);
      assert.equal(complete1.json.file.id, init40.json.fileId);
      assert.equal(complete1.json.file.fileName, "ملف_كبير_40ميجا.xlsx");
      assert.equal(complete1.json.file.fileSize, size40MB);
      assert.equal(complete1.json.file.recordsCount, 500747);

      // 11h. Re-sending /complete (idempotency retry) returns 200 without creating a duplicate DB row!
      const countBeforeReplay = mockDb.tables.manager_files.filter((f) => f.id === init40.json.fileId).length;
      const completeReplay = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/complete", {
        body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed", uploadSessionToken: init40.json.uploadSessionToken }
      });
      assert.equal(completeReplay.status, 200);
      assert.equal(completeReplay.json.alreadyCompleted, true);
      assert.equal(completeReplay.json.file.id, init40.json.fileId);
      assert.equal(mockDb.tables.manager_files.filter((f) => f.id === init40.json.fileId).length, countBeforeReplay);

      // 11i. Disguised non-Excel file (invalid magic bytes) is rejected at /complete AND auto-removed from Storage!
      const badInit = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/init", {
        body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed", fileName: "fake.xlsx", fileSize: 128 }
      });
      assert.equal(badInit.status, 200);
      mockDb.storageBuckets["manager-files"].set(badInit.json.storagePath, {
        bytes: Buffer.from("MZ_NOT_AN_EXCEL_FILE_EXECUTABLE_PAYLOAD_PADDING".padEnd(128, "X")),
        createdAt: new Date().toISOString(),
        etag: "bad-etag"
      });
      const badComplete = await httpRequest(port, "POST", "/api/farzon/manager/files/upload/complete", {
        body: { code: mgrMohamedCode, deviceId: "dev-mgr-mohamed", uploadSessionToken: badInit.json.uploadSessionToken }
      });
      assert.equal(badComplete.status, 400);
      assert.equal(badComplete.json.status, "invalid_file");
      assert.equal(mockDb.storageBuckets["manager-files"].has(badInit.json.storagePath), false, "Invalid file must be purged from Storage");

      // 11j. Manager-User requests short-lived Signed Download URL for the 40 MB file -> 200 OK (zero bytes through Render)
      const dlUrlOk = await httpRequest(port, "POST", `/api/farzon/files/${init40.json.fileId}/download-url`, {
        body: { code: mohamedUserCode, deviceId: "dev-user-mohamed" }
      });
      assert.equal(dlUrlOk.status, 200);
      assert.equal(dlUrlOk.json.success, true);
      assert.equal(dlUrlOk.json.fileSize, size40MB);
      assert.ok(dlUrlOk.json.signedDownloadUrl.includes(init40.json.storagePath));

      // 11k. Another manager's user CANNOT obtain Signed Download URL for Mohamed's 40 MB file (403 forbidden_group)
      const dlUrlCrossBlocked = await httpRequest(port, "POST", `/api/farzon/files/${init40.json.fileId}/download-url`, {
        body: { code: ahmedUser30Code, deviceId: "dev-user-a30" }
      });
      assert.equal(dlUrlCrossBlocked.status, 403);
      assert.equal(dlUrlCrossBlocked.json.status, "forbidden_group");
    } finally {
      if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
      if (prevServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevServiceKey;
      if (prevAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = prevAnonKey;
    }
  });
});
