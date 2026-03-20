/**
 * 芳萃本草｜Firebase Cloud Functions × 綠界金流
 * 
 * 功能：
 *  1. createECPayOrder  — 前端結帳時呼叫，產生綠界付款表單
 *  2. ecpayCallback     — 綠界付款完成後回呼，更新訂單狀態
 *  3. ecpayOrderQuery   — 主動查詢訂單付款狀態（選用）
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ============================================================
// 金流設定（直接寫在這裡）
// ⚠️ 注意：上線後不要把這個檔案分享給別人或上傳到 GitHub
// ============================================================
function getConfig() {
  return {
    MERCHANT_ID:   "3103095",
    HASH_KEY:      "JUi73W4Zh58OsEqE",
    HASH_IV:       "BjcWioK6rMb3O5Jv",
    IS_PRODUCTION: true,                      // true = 正式環境（會真的扣款）
    BASE_URL:      "https://yourdomain.com",  // ← 換成你的實際網址
  };
}

// 綠界 API 網址
function ecpayUrl(path, isProduction) {
  const base = isProduction
    ? "https://payment.ecpay.com.tw"
    : "https://payment-stage.ecpay.com.tw";
  return base + path;
}

// ============================================================
// 工具：產生 CheckMacValue（SHA256 加密）
// ============================================================
function genCheckMacValue(params, hashKey, hashIV) {
  // 1. 依 key 字母順序排序
  const sorted = Object.keys(params)
    .filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // 2. 組合字串
  let raw = `HashKey=${hashKey}`;
  sorted.forEach(k => { raw += `&${k}=${params[k]}`; });
  raw += `&HashIV=${hashIV}`;

  // 3. URL Encode（小寫）
  raw = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%20/g, "+")
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%20/g, "+");

  // 4. SHA256
  return crypto.createHash("sha256").update(raw).digest("hex").toUpperCase();
}

// ============================================================
// 工具：付款方式 → 綠界 ChoosePayment
// ============================================================
function mapPayment(method) {
  const map = {
    credit:  "Credit",
    atm:     "ATM",
    cvs:     "CVS",
    linepay: "Credit",  // LINE Pay 需額外申請，暫用信用卡
  };
  return map[method] || "Credit";
}

// ============================================================
// 1. createECPayOrder — HTTPS 可呼叫函式
// ============================================================
exports.createECPayOrder = functions
  .region("asia-east1")
  .https.onRequest(async (req, res) => {
    // CORS
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    try {
      const { orderId, paymentMethod } = req.body;
      if (!orderId) { res.status(400).json({ error: "缺少 orderId" }); return; }

      // 從 Firestore 讀取訂單
      const orderSnap = await db.collection("orders").doc(orderId).get();
      if (!orderSnap.exists) { res.status(404).json({ error: "訂單不存在" }); return; }
      const order = orderSnap.data();

      const { MERCHANT_ID, HASH_KEY, HASH_IV, IS_PRODUCTION, BASE_URL } = getConfig();

      // 綠界需要的商品名稱（最多 200 字，特殊字元需移除）
      const itemNames = (order.items || [])
        .map(i => `${i.name} x${i.qty}`)
        .join("#")
        .replace(/[&=,><'"\\]/g, " ")
        .slice(0, 200);

      // 訂單時間 (yyyy/MM/dd HH:mm:ss)
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const tradeDate = `${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      // 綠界商店訂單編號（英數字，最多 20 碼）
      const merchantTradeNo = orderId.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "");

      const params = {
        MerchantID:        MERCHANT_ID,
        MerchantTradeNo:   merchantTradeNo,
        MerchantTradeDate: tradeDate,
        PaymentType:       "aio",
        TotalAmount:       String(Math.round(order.total || 0)),
        TradeDesc:         encodeURIComponent("芳萃本草精油訂購"),
        ItemName:          itemNames,
        ReturnURL:         `${BASE_URL}/api/ecpayCallback`,
        OrderResultURL:    `${BASE_URL}/order.html?id=${orderId}`,
        ChoosePayment:     mapPayment(paymentMethod || order.payment?.method),
        EncryptType:       "1",
        ClientBackURL:     `${BASE_URL}/cart.html`,
        CustomField1:      orderId,
      };

      // ATM 額外參數
      if (params.ChoosePayment === "ATM") {
        params.ExpireDate = "3";
      }

      // 超商額外參數
      if (params.ChoosePayment === "CVS") {
        params.StoreExpireSeconds = "86400";
        params.Desc_1 = "芳萃本草精油";
      }

      // 產生 CheckMacValue
      params.CheckMacValue = genCheckMacValue(params, HASH_KEY, HASH_IV);

      // 產生自動提交的 HTML 表單
      const formHtml = buildPaymentForm(
        ecpayUrl("/Cashier/AioCheckOut/V5", IS_PRODUCTION),
        params
      );

      // 記錄綠界訂單號到 Firestore
      await db.collection("orders").doc(orderId).update({
        "payment.merchantTradeNo": merchantTradeNo,
        "payment.status": "pending",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).send(formHtml);

    } catch (err) {
      console.error("createECPayOrder error:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ============================================================
// 2. ecpayCallback — 綠界付款完成後的 Server 端回呼
// ============================================================
exports.ecpayCallback = functions
  .region("asia-east1")
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    try {
      const data = req.body;
      const { HASH_KEY, HASH_IV } = getConfig();

      // 驗證 CheckMacValue，防止偽造
      const receivedMac = data.CheckMacValue;
      const computed = genCheckMacValue(data, HASH_KEY, HASH_IV);

      if (receivedMac !== computed) {
        console.error("CheckMacValue 驗證失敗", { receivedMac, computed });
        res.status(200).send("0|CheckMacValue Error");
        return;
      }

      const rtnCode = data.RtnCode;
      const orderId = data.CustomField1;
      const tradeNo = data.TradeNo;

      if (!orderId) {
        res.status(200).send("0|Missing OrderId");
        return;
      }

      const updateData = {
        "payment.tradeNo":   tradeNo,
        "payment.rtnCode":   rtnCode,
        "payment.rtnMsg":    data.RtnMsg,
        "payment.paidAt":    admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
      };

      if (rtnCode === "1") {
        updateData["payment.status"] = "paid";
        updateData["status"]         = "paid";

        if (data.BankCode) {
          updateData["payment.bankCode"]      = data.BankCode;
          updateData["payment.accountNumber"] = data.vAccount;
          updateData["payment.expireDate"]    = data.ExpireDate;
        }

        if (data.PaymentNo) {
          updateData["payment.paymentNo"]  = data.PaymentNo;
          updateData["payment.expireDate"] = data.ExpireDate;
        }

        console.log(`✅ 訂單 ${orderId} 付款成功，綠界交易號：${tradeNo}`);
      } else {
        updateData["payment.status"] = "failed";
        updateData["status"]         = "pending";
        console.warn(`❌ 訂單 ${orderId} 付款失敗，RtnCode: ${rtnCode}`);
      }

      await db.collection("orders").doc(orderId).update(updateData);
      res.status(200).send("1|OK");

    } catch (err) {
      console.error("ecpayCallback error:", err);
      res.status(200).send("0|Server Error");
    }
  });

// ============================================================
// 3. ecpayOrderQuery — 主動查詢訂單付款狀態（選用）
// ============================================================
exports.ecpayOrderQuery = functions
  .region("asia-east1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method !== "GET") { res.status(405).send(); return; }

    const orderId = req.query.orderId;
    if (!orderId) { res.status(400).json({ error: "缺少 orderId" }); return; }

    try {
      const orderSnap = await db.collection("orders").doc(orderId).get();
      if (!orderSnap.exists) { res.status(404).json({ error: "訂單不存在" }); return; }

      const order = orderSnap.data();
      const merchantTradeNo = order.payment?.merchantTradeNo;
      if (!merchantTradeNo) { res.status(400).json({ error: "尚未建立綠界訂單" }); return; }

      const { MERCHANT_ID, HASH_KEY, HASH_IV, IS_PRODUCTION } = getConfig();
      const timeStamp = String(Math.floor(Date.now() / 1000));

      const params = {
        MerchantID:      MERCHANT_ID,
        MerchantTradeNo: merchantTradeNo,
        TimeStamp:       timeStamp,
      };
      params.CheckMacValue = genCheckMacValue(params, HASH_KEY, HASH_IV);

      const queryUrl = ecpayUrl("/Cashier/QueryTradeInfo/V5", IS_PRODUCTION);
      const qs = new URLSearchParams(params).toString();
      const response = await axios.post(queryUrl, qs, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });

      const result = Object.fromEntries(new URLSearchParams(response.data));
      res.status(200).json({ status: result.TradeStatus, raw: result });

    } catch (err) {
      console.error("ecpayOrderQuery error:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ============================================================
// 工具：組合綠界付款 HTML 表單
// ============================================================
function buildPaymentForm(actionUrl, params) {
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
    .join("\n    ");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>跳轉至綠界付款頁面…</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #F7F3EC; flex-direction: column; gap: 1rem; }
    p { color: #5C4E38; font-size: 1rem; letter-spacing: 0.05em; }
    .spinner { width: 36px; height: 36px; border: 3px solid rgba(78,94,69,0.2); border-top-color: #4E5E45; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>正在跳轉至付款頁面，請稍候…</p>
  <form id="ecpayForm" method="POST" action="${actionUrl}">
    ${inputs}
  </form>
  <script>document.getElementById('ecpayForm').submit();</script>
</body>
</html>`;
}
