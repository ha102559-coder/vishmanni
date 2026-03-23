const crypto = require('crypto');

// ===== 綠界正式環境設定 =====
const HASH_KEY = process.env.ECPAY_HASH_KEY;
const HASH_IV  = process.env.ECPAY_HASH_IV;

// ===== Firebase Admin 初始化 =====
let db;
function getDb() {
  if (db) return db;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  db = admin.firestore();
  return db;
}

// ===== CheckMacValue 驗證 =====
function verifyCheckMacValue(params) {
  const received = params.CheckMacValue;

  // 排除 CheckMacValue 本身
  const filtered = { ...params };
  delete filtered.CheckMacValue;

  const sorted = Object.keys(filtered)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${filtered[k]}`)
    .join('&');

  const raw = `HashKey=${HASH_KEY}&${sorted}&HashIV=${HASH_IV}`;

  const encoded = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%20/g, '+')
    .replace(/%21/g, '!')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2a/g, '*')
    .replace(/%7e/g, '~');

  const computed = crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();

  return computed === received;
}

// ===== 主 Handler =====
exports.handler = async (event) => {
  // 只處理 POST（綠界幕後回傳是 POST）
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 解析綠界回傳的表單資料
    const params = Object.fromEntries(new URLSearchParams(event.body));

    console.log('ECPay callback received:', JSON.stringify(params));

    // 1. 驗證 CheckMacValue（防偽）
    if (!verifyCheckMacValue(params)) {
      console.error('CheckMacValue 驗證失敗');
      return { statusCode: 200, body: '0|CheckMacValue Error' };
    }

    const {
      MerchantTradeNo,  // 你的訂單編號（前 20 碼）
      RtnCode,          // 1 = 付款成功
      RtnMsg,
      TradeNo,          // 綠界交易編號
      TradeAmt,
      PaymentType,
      PaymentDate,
      // ATM 相關
      BankCode,
      vAccount,
      ExpireDate,
    } = params;

    const firestore = getDb();

    // 2. 用 MerchantTradeNo 找到對應的 Firestore 訂單
    // 因為 tradeNo 是 orderId 的前 20 碼，用 query 查詢
    const ordersRef = firestore.collection('orders');
    const snap = await ordersRef
      .where('__name__', '>=', MerchantTradeNo)
      .limit(1)
      .get();

    // 直接用 MerchantTradeNo 當 doc id 查（因為我們存的就是 orderId slice）
    // 改為直接 get 所有訂單中 tradeNo 對應的
    // 最簡單：直接拿 orderId（你在 create 時存了 tradeNo，這裡反查）
    const querySnap = await ordersRef
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    let orderRef = null;
    querySnap.forEach(doc => {
      const id = doc.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
      if (id === MerchantTradeNo) {
        orderRef = doc.ref;
      }
    });

    if (!orderRef) {
      console.error('找不到對應訂單：', MerchantTradeNo);
      return { statusCode: 200, body: '0|Order Not Found' };
    }

    // 3. 依付款結果更新訂單
    if (RtnCode === '1') {
      // 付款成功
      await orderRef.update({
        status: 'paid',
        'payment.status': 'paid',
        'payment.tradeNo': TradeNo,
        'payment.paymentType': PaymentType,
        'payment.paymentDate': PaymentDate,
        'payment.tradeAmt': Number(TradeAmt),
        updatedAt: new Date(),
      });
      console.log('訂單付款成功更新：', MerchantTradeNo);

    } else if (PaymentType && PaymentType.startsWith('ATM')) {
      // ATM 尚未付款，但已取得虛擬帳號
      await orderRef.update({
        status: 'pending',
        'payment.status': 'awaiting_atm',
        'payment.bankCode': BankCode || '',
        'payment.accountNumber': vAccount || '',
        'payment.expireDate': ExpireDate || '',
        updatedAt: new Date(),
      });
      console.log('ATM 虛擬帳號已產生：', MerchantTradeNo);

    } else {
      // 付款失敗
      await orderRef.update({
        status: 'payment_failed',
        'payment.status': 'failed',
        'payment.rtnMsg': RtnMsg,
        updatedAt: new Date(),
      });
      console.log('訂單付款失敗：', MerchantTradeNo, RtnMsg);
    }

    // 4. 回傳 1|OK 給綠界（必須，否則綠界會一直重試）
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: '1|OK',
    };

  } catch (err) {
    console.error('ecpay-callback error:', err);
    // 就算出錯也要回 200，避免綠界誤判
    return {
      statusCode: 200,
      body: '0|Server Error',
    };
  }
};
