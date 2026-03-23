const crypto = require('crypto');

// ===== 綠界正式環境設定 =====
const MERCHANT_ID = process.env.ECPAY_MERCHANT_ID;
const HASH_KEY    = process.env.ECPAY_HASH_KEY;
const HASH_IV     = process.env.ECPAY_HASH_IV;
const BASE_URL    = process.env.BASE_URL;

// 正式環境 API 網址
const ECPAY_URL = 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5';

// ===== CheckMacValue 計算 =====
function generateCheckMacValue(params) {
  // 1. 依照參數名稱英文字母排序
  const sorted = Object.keys(params)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${params[k]}`)
    .join('&');

  // 2. 加上 HashKey 和 HashIV
  const raw = `HashKey=${HASH_KEY}&${sorted}&HashIV=${HASH_IV}`;

  // 3. URL Encode（綠界規定）
  const encoded = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%20/g, '+')
    .replace(/%21/g, '!')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2a/g, '*')
    .replace(/%7e/g, '~');  // 根据绿界文档保持一致

  // 4. SHA256 加密後轉大寫
  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
}

// ===== 付款方式對應 =====
function getChoosePayment(method) {
  const map = {
    credit:  'Credit',
    atm:     'ATM',
    cvs:     'CVS',
    linepay: 'ALL', // LINE Pay 走 ALL 或另外串接
  };
  return map[method] || 'Credit';
}

// ===== 主 Handler =====
exports.handler = async (event) => {
  // 只允許 POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { orderId, total, paymentMethod, shippingMethod } = JSON.parse(event.body);

    if (!orderId || !total) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少必要參數' }) };
    }

    // 綠界訂單編號限制：英數字、長度 ≤ 20
    const tradeNo = orderId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);

    // 商品名稱（綠界不能有特殊符號）
    const itemName = '芳萃本草商品';

    // 日期格式：yyyy/MM/dd HH:mm:ss
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const tradeDate = `${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    // 組合參數
    const params = {
      MerchantID:        MERCHANT_ID,
      MerchantTradeNo:   tradeNo,
      MerchantTradeDate: tradeDate,
      PaymentType:       'aio',
      TotalAmount:       String(Math.round(total)),
      TradeDesc:         '芳萃本草線上訂單',
      ItemName:          itemName,
      ReturnURL:         `${BASE_URL}/.netlify/functions/ecpay-callback`,
      OrderResultURL:    `${BASE_URL}/order.html?id=${orderId}`,
      ChoosePayment:     getChoosePayment(paymentMethod),
      EncryptType:       '1',
      ClientBackURL:     `${BASE_URL}/order.html?id=${orderId}`,
    };

    // ATM 額外設定
    if (paymentMethod === 'atm') {
      params.ExpireDate = '3'; // 3 天內繳款
    }

    // 超商繳費額外設定
    if (paymentMethod === 'cvs') {
      params.StoreExpireDate = '10080'; // 7 天（分鐘）
    }

    // 計算 CheckMacValue
    params.CheckMacValue = generateCheckMacValue(params);

    // 產生自動提交的 HTML 表單（跳轉到綠界付款頁）
    const formFields = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
      .join('\n');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>跳轉付款中...</title>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center;
           align-items: center; height: 100vh; margin: 0; background: #f9f6f0; }
    .box { text-align: center; color: #555; }
    .spinner { width: 40px; height: 40px; border: 3px solid #ddd;
               border-top-color: #7a9e7e; border-radius: 50%;
               animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <p>正在跳轉至綠界付款頁面，請稍候…</p>
  </div>
  <form id="ecpayForm" method="POST" action="${ECPAY_URL}">
    ${formFields}
  </form>
  <script>document.getElementById('ecpayForm').submit();</script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    };

  } catch (err) {
    console.error('create-ecpay-order error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '伺服器錯誤：' + err.message }),
    };
  }
};
