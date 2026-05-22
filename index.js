const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// ==========================================
// [1] 서버 기본 설정
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;

const whitelist = [
    'https://yogibo.kr',
    'https://www.yogibo.kr',
    'http://skin-skin123.yogibo.cafe24.com', 
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || origin === 'null' || whitelist.indexOf(origin) !== -1 || origin.includes('cafe24.com')) {
            callback(null, true);
        } else {
            console.log("🚫 CORS 차단됨:", origin);
            callback(new Error('CORS 정책에 의해 차단되었습니다.'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'], 
    allowedHeaders: ['Content-Type', 'Authorization', 'userid', 'Cache-Control', 'Pragma'], 
    credentials: true 
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// [2] 환경변수 및 DB 컬렉션 설정
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "OFFLINE_ORDER"; 

const COLLECTION_ORDERS = "ordersOffData";
const COLLECTION_TOKENS = "tokens";
const COLLECTION_STORES = "ecountStores";
const COLLECTION_STATIC_MANAGERS = "staticManagers";
const COLLECTION_WAREHOUSES = "ecountWarehouses";
const COLLECTION_CS_MEMOS = "csMemos";
const COLLECTION_PIN_DATA = "OFFPINDATA"; 
const COLLECTION_AUTH = "authSettings";   
const COLLECTION_COUPON_MAP = "couponProductMap";
const COLLECTION_DELIVERIES = "deliveryShipments";  // 🚚 출하 매핑용
const COLLECTION_WORK_HOURS = "workHours";          // 🕐 매니저 근무·시차 관리

// 🚚 배송완료 추정 일수 (출하 후 N일 경과 시 자동 '배송완료'로 표시)
const DELIVERY_ESTIMATE_DAYS = 3;

// 🕐 근무 관리 정책
const WORK_STANDARD_HOURS  = 8;    // 일 표준 근무시간 (평일 기준, 호환용)
const WORK_BREAK_MINUTES   = 60;   // 점심시간 자동 차감
// 🆕 평일 8h / 주말 9h 기준 근무시간
function getStandardHoursByDate(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return WORK_STANDARD_HOURS;
    const [y, m, d] = dateStr.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();   // 0=일, 6=토
    return (dow === 0 || dow === 6) ? 9 : 8;
}

const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const CAFE24_API_VERSION = '2025-12-01';

const BIZM_USER_ID = process.env.BIZM_USER_ID;
const BIZM_PROFILE_KEY = process.env.BIZM_PROFILE_KEY;
const BIZM_SENDER_PHONE = process.env.BIZM_SENDER_PHONE;
const MY_DOMAIN = process.env.MY_DOMAIN || "https://yogibo.kr"; 

let db;
let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

// ==========================================
// [2-1] 🆕 주문 상태 머신 상수
// ==========================================
const ORDER_STATUS = {
    PENDING:   'PENDING',    // 신규 주문 (미전송)
    EXPORTED:  'EXPORTED',   // 엑셀 다운로드됨, 이카운트 결과 미확인 (확정 대기)
    CONFIRMED: 'CONFIRMED',  // 이카운트 등록 확정 (전송완료)
    FAILED:    'FAILED'      // 이카운트 거절됨 (등록 실패)
};

// 🆕 자동 복구 설정: EXPORTED 상태로 N분 이상 방치 시 PENDING으로 자동 복구
// (매크로 최대 재시도 4분 + 버퍼 4분 = 8분, 매크로 진행 중 잘못 복구되는 중복 등록 방지)
const AUTO_REQUEUE_STALE_MINUTES = 8;

// ==========================================
// [3] 서버 시작
// ==========================================
async function startServer() {
    try {
        console.log("-----------------------------------------");
        console.log("⏳ System Booting...");
        
        if (!MONGODB_URI) throw new Error("MONGODB_URI is missing in .env");
        if (!CAFE24_MALLID) throw new Error("CAFE24_MALLID is missing in .env");

        const client = await MongoClient.connect(MONGODB_URI);
        console.log(`✅ MongoDB Connected to [${DB_NAME}]`);
        db = client.db(DB_NAME);

        try {
            const tokenDoc = await db.collection(COLLECTION_TOKENS).findOne({});
            if (tokenDoc) {
                accessToken = tokenDoc.accessToken;
                refreshToken = tokenDoc.refreshToken;
            }
        } catch (e) {}

        await initializeWarehouseDB(); 
        await initializeGlobalPin(); 
        await seedCollectionFromJSON('ECOUNT_STORES.json', COLLECTION_STORES);
        await seedCollectionFromJSON('STATIC_MANAGER_LIST.json', COLLECTION_STATIC_MANAGERS);

        // 🆕 기존 주문 데이터 status 필드 마이그레이션 (1회성, 안전)
        await migrateOrderStatus();

        // 🆕 인덱스 생성 (성능)
        await ensureOrderIndexes();
        await ensureDeliveryIndexes();
        await ensureWorkHoursIndexes();

        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

        // 🆕 자동 복구 cron 시작 (서버 시작 후 5초 뒤 첫 실행)
        setTimeout(() => {
            startAutoRequeueCron();
            // 서버 시작 직후 한 번 즉시 실행 (혹시 다운타임 동안 쌓인 건 처리)
            performAutoRequeue();
        }, 5000);

    } catch (err) {
        console.error("🔥 Server Error:", err);
    }
}
startServer();

async function initializeGlobalPin() {
    try {
        const count = await db.collection(COLLECTION_AUTH).countDocuments({ type: 'global_pin' });
        if (count === 0) {
            await db.collection(COLLECTION_AUTH).insertOne({ type: 'global_pin', pinCode: '1111', created_at: new Date() });
            console.log("🔑 기본 통합 비밀번호(1111)가 생성되었습니다.");
        }
    } catch (e) {}
}

async function seedCollectionFromJSON(filename, collectionName) {
    try {
        const count = await db.collection(collectionName).countDocuments();
        if (count > 0) return;
        const jsonPath = path.join(__dirname, filename);
        if (!fs.existsSync(jsonPath)) return;
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (!Array.isArray(data) || data.length === 0) return;
        const docs = data.map(item => {
            const { _id, ...rest } = item; 
            return { ...rest, created_at: new Date(), source: 'json_seed' };
        });
        await db.collection(collectionName).insertMany(docs);
    } catch (e) {}
}

async function initializeWarehouseDB() {
    try {
        const collection = db.collection(COLLECTION_WAREHOUSES);
        const count = await collection.countDocuments();
        if (count === 0) {
            await collection.insertMany([{ warehouse_code: 'C0001', warehouse_name: '판매입력(물류센터) (기본)', created_at: new Date() }]);
        }
    } catch (e) {}
}

// 🆕 기존 주문 데이터를 새 status 필드로 마이그레이션
async function migrateOrderStatus() {
    try {
        const collection = db.collection(COLLECTION_ORDERS);
        
        const needsMigration = await collection.countDocuments({ status: { $exists: false } });
        if (needsMigration === 0) {
            console.log("✅ Order Status 마이그레이션: 이미 완료됨 (스킵)");
            return;
        }

        console.log(`⏳ Order Status 마이그레이션 시작: ${needsMigration}건 처리 중...`);

        const r1 = await collection.updateMany(
            { status: { $exists: false }, is_synced: true },
            { $set: { status: ORDER_STATUS.CONFIRMED, ecount_confirmed_at: new Date() } }
        );

        const r2 = await collection.updateMany(
            { status: { $exists: false } },
            { $set: { status: ORDER_STATUS.PENDING } }
        );

        console.log(`✅ 마이그레이션 완료: CONFIRMED ${r1.modifiedCount}건, PENDING ${r2.modifiedCount}건`);
    } catch (e) {
        console.error("⚠️ 마이그레이션 오류 (서버는 계속 실행):", e.message);
    }
}

// 🆕 자주 쓰는 쿼리에 인덱스 추가
async function ensureOrderIndexes() {
    try {
        const collection = db.collection(COLLECTION_ORDERS);
        await collection.createIndex({ status: 1, is_deleted: 1, created_at: -1 });
        await collection.createIndex({ excel_batch_id: 1 });
        await collection.createIndex({ store_name: 1, created_at: -1 });
        // 🆕 자동 복구 쿼리 최적화용 인덱스
        await collection.createIndex({ status: 1, excel_downloaded_at: 1, auto_requeued: 1 });
        console.log("✅ 인덱스 확인 완료");
    } catch (e) {
        console.error("⚠️ 인덱스 생성 오류:", e.message);
    }
}

async function refreshAccessToken() {
    try {
        const basicAuth = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
        const response = await axios.post(
            `https://${CAFE24_MALLID}.cafe24api.com/api/v2/oauth/token`,
            `grant_type=refresh_token&refresh_token=${refreshToken}`,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` } }
        );
        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;
        if (db) await db.collection(COLLECTION_TOKENS).updateOne({}, { $set: { accessToken, refreshToken, updatedAt: new Date() } }, { upsert: true });
        return accessToken;
    } catch (error) { throw error; }
}

// ==========================================
// [4] 매장 접속 권한 및 통합 PIN 검증 API
// ==========================================
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { pin } = req.body;
        const setting = await db.collection(COLLECTION_AUTH).findOne({ type: 'global_pin' });
        
        if (setting && String(setting.pinCode) === String(pin)) {
            res.json({ success: true, token: pin }); 
        } else {
            res.json({ success: false, message: '통합 비밀번호가 다릅니다.' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.put('/api/auth/global-pin', async (req, res) => {
    try {
        const { newPin } = req.body;
        if (!newPin) return res.status(400).json({ success: false, message: '비밀번호를 입력해주세요.' });

        await db.collection(COLLECTION_AUTH).updateOne(
            { type: 'global_pin' },
            { $set: { pinCode: String(newPin), updated_at: new Date() } },
            { upsert: true }
        );
        res.json({ success: true, message: '통합 비밀번호가 변경되었습니다.' });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/auth/store/login', async (req, res) => {
    try {
        const { storeName, password } = req.body;
        const cred = await db.collection(COLLECTION_PIN_DATA).findOne({ storeName: storeName });
        
        if (cred && String(cred.password) === String(password)) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '비밀번호 불일치' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/auth/store/password', async (req, res) => {
    try {
        const { storeName, password } = req.body;
        if (!storeName || !password) return res.status(400).json({ success: false, message: '값 누락' });
        
        await db.collection(COLLECTION_PIN_DATA).updateOne(
            { storeName: storeName }, 
            { $set: { password: String(password), updatedAt: new Date() } }, 
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/auth/store/credentials', async (req, res) => {
    try {
        const credentials = await db.collection(COLLECTION_PIN_DATA).find({}).toArray();
        res.json({ success: true, data: credentials });
    } catch (e) { res.status(500).json({ success: false }); }
});

const authMiddleware = async (req, res, next) => {
    console.log("⚠️ 현재 주문 등록 보안 인증이 임시로 해제되어 무조건 통과됩니다.");
    return next(); 
};

// ==========================================
// [5] Cafe24 API (상품 & 옵션 조회)
// ==========================================
app.get('/api/cafe24/categories', async (req, res) => {
    try {
        let allCategories = [];
        let offset = 0;
        const limit = 100;
        let hasMore = true;
        let loopCount = 0;

        while (hasMore && loopCount < 10) {
            const fetchFromCafe24 = async (retry = false) => {
                try {
                    return await axios.get(
                        `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/categories`,
                        {
                            params: { shop_no: 1, limit: limit, offset: offset },
                            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                        }
                    );
                } catch (err) {
                    if (err.response && err.response.status === 401 && !retry) {
                        await refreshAccessToken();
                        return await fetchFromCafe24(true);
                    }
                    throw err;
                }
            };

            const response = await fetchFromCafe24();
            const cats = response.data.categories || [];
            allCategories = allCategories.concat(cats);

            if (cats.length < limit) {
                hasMore = false;
            } else {
                offset += limit;
            }
            loopCount++;
        }

        res.json({ success: true, data: allCategories });
    } catch (error) {
        console.error("🔥 Cafe24 카테고리 목록 조회 에러:", error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
    }
});

// 🆕 Cafe24 상품명 → 내부 매핑명 치환 룰
//    오프라인 주문서에서 가져오는 모든 상품명에 적용됨 (검색/카테고리 공통)
//    추가 룰: 아래 배열에 [정규식, 치환문자열] 추가
const CAFE24_PRODUCT_NAME_RULES = [
    [/더블\s*맥스/g, '더블'],
];
function normalizeCafe24ProductName(name) {
    if (!name) return name;
    let r = String(name);
    CAFE24_PRODUCT_NAME_RULES.forEach(([re, to]) => { r = r.replace(re, to); });
    return r;
}

// 🆕 "프리미엄" 포함 상품은 EPP 복사본 추가
//   - 단, "프리미엄 플러스"는 제외 (Plus 라인은 EPP 옵션 없음)
//   - 같은 product_no 유지 (옵션 조회는 동일 Cafe24 상품에서 가져옴)
//   - product_name 끝에 " EPP" 부착
//   - is_epp 플래그로 구분 가능
function expandPremiumWithEPP(products) {
    if (!Array.isArray(products)) return products;
    const out = [];
    products.forEach(p => {
        out.push(p);
        if (!p || !p.product_name) return;
        const name = p.product_name;
        // 프리미엄 포함 + 플러스 미포함 + 이미 EPP 아님
        if (/프리미엄/.test(name) && !/플러스/.test(name) && !/EPP/i.test(name)) {
            out.push({
                ...p,
                product_name: `${name} EPP`,
                is_epp: true
            });
        }
    });
    return out;
}

app.get('/api/cafe24/categories/:categoryNo/products', async (req, res) => {
    try {
        const { categoryNo } = req.params;
        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                    {
                        params: { shop_no: 1, category: categoryNo, display: 'T', selling: 'T', embed: 'options,images', limit: 100 },
                        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                    }
                );
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) {
                    await refreshAccessToken();
                    return await fetchFromCafe24(true);
                }
                throw err;
            }
        };
//
        const response = await fetchFromCafe24();
        // 🆕 상품명 매핑 룰 적용 + 프리미엄 EPP 복사본 추가
        let products = (response.data.products || []).map(p => ({
            ...p,
            product_name: normalizeCafe24ProductName(p.product_name)
        }));
        products = expandPremiumWithEPP(products);
        res.json({ success: true, data: products });
    } catch (error) {
        console.error("🔥 Cafe24 카테고리별 상품 조회 에러:", error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
    }
});

app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                    {
                        params: { shop_no: 1, product_name: keyword, display: 'T', selling: 'T', embed: 'options,images', limit: 100, sort: 'created_date', order: 'asc' },
                        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                    }
                );
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) {
                    await refreshAccessToken();
                    return await fetchFromCafe24(true);
                }
                throw err;
            }
        };

        const response = await fetchFromCafe24();
        const products = response.data.products || [];
        let cleanData = products.map(item => {
            let myOptions = [];
            let rawOptionList = item.options ? (Array.isArray(item.options) ? item.options : item.options.options) : [];
            
            if (rawOptionList.length > 0) {
                let targetOption = rawOptionList.find(opt => {
                    const name = (opt.option_name || opt.name || "").toLowerCase();
                    return name.includes('색상') || name.includes('color');
                }) || rawOptionList[0];
                if (targetOption && targetOption.option_value) {
                    myOptions = targetOption.option_value.map(val => ({
                        option_code: val.value_no || val.value_code || val.value,
                        option_name: val.value_name || val.option_text || val.name
                    }));
                }
            }
            let img = item.detail_image || item.list_image || item.small_image || (item.images && item.images[0] && item.images[0].big);
            return {
                product_no: item.product_no,
                product_name: normalizeCafe24ProductName(item.product_name), // 🆕 상품명 매핑 적용
                price: Math.floor(Number(item.price)), options: myOptions,
                detail_image: img
            };
        });
        // 🆕 프리미엄 EPP 복사본 추가
        cleanData = expandPremiumWithEPP(cleanData);
        res.json({ success: true, count: cleanData.length, data: cleanData });
    } catch (error) { res.status(500).json({ success: false, message: "Cafe24 API Error" }); }
});

app.get('/api/cafe24/products/:productNo/options', async (req, res) => {
    try {
        const { productNo } = req.params;
        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${productNo}`,
                    { params: { shop_no: 1, embed: 'options' }, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } }
                );
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) { await refreshAccessToken(); return await fetchFromCafe24(true); }
                throw err;
            }
        };
        const response = await fetchFromCafe24();
        const product = response.data.product;
        let myOptions = [];
        let rawOptionList = Array.isArray(product.options) ? product.options : (product.options && product.options.options ? product.options.options : []);
        
        if (rawOptionList.length > 0) {
            let targetOption = rawOptionList.find(opt => {
                const name = (opt.option_name || opt.name || "").toLowerCase();
                return name.includes('색상') || name.includes('color');
            }) || rawOptionList[0];
            if (targetOption && targetOption.option_value) {
                myOptions = targetOption.option_value.map(val => ({
                    option_code: val.value_no || val.value_code || val.value,
                    option_name: val.value_name || val.option_text || val.name
                }));
            }
        }
        res.json({
            success: true,
            product_no: product.product_no,
            product_name: normalizeCafe24ProductName(product.product_name), // 🆕 상품명 매핑 적용
            options: myOptions
        });
    } catch (error) { res.status(500).json({ success: false, message: "Cafe24 API Error" }); }
});

// ==========================================
// [5-2] Cafe24 쿠폰 및 자동 매핑 API
// ==========================================
app.get('/api/cafe24/coupons', async (req, res) => {
    try {
        const fetchFromCafe24 = async (url, params, retry = false) => {
            try {
                return await axios.get(url, {
                    params,
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Cafe24-Api-Version': CAFE24_API_VERSION
                    }
                });
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) {
                    await refreshAccessToken();
                    return await fetchFromCafe24(url, params, true);
                }
                throw err;
            }
        };

        const listRes = await fetchFromCafe24(
            `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`,
            { shop_no: 1, limit: 100, issue_type: 'D' }
        );
        const coupons = listRes.data.coupons || [];

        const now = new Date();
        const activeCoupons = coupons.filter(c => {
            if (c.deleted === 'T') return false;
            if (c.is_stopped_issued_coupon === 'T') return false;
            if (c.issue_type !== 'D') return false;
            if (c.issue_start_date && new Date(c.issue_start_date) > now) return false;
            if (c.issue_end_date && new Date(c.issue_end_date) < now) return false;
            if (c.available_period_type === 'F') {
                if (c.available_start_datetime && new Date(c.available_start_datetime) > now) return false;
                if (c.available_end_datetime && new Date(c.available_end_datetime) < now) return false;
            }
            return true;
        });

        const detailResults = await Promise.allSettled(
            activeCoupons.map(c => fetchFromCafe24(`https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons/${c.coupon_no}`, { shop_no: 1 }))
        );

        const enriched = activeCoupons.map((c, idx) => {
            let availableProducts = [];
            let availableProductType = c.available_product_type || 'A';
            const detail = detailResults[idx];
            
            if (detail.status === 'fulfilled' && detail.value.data.coupon) {
                const dc = detail.value.data.coupon;
                availableProductType = dc.available_product_type || availableProductType;
                const raw = dc.available_product;
                if (Array.isArray(raw)) {
                    availableProducts = raw.map(p => (typeof p === 'object' && p !== null && p.product_no) ? Number(p.product_no) : Number(p)).filter(n => !isNaN(n));
                } else if (typeof raw === 'number') {
                    availableProducts = [raw];
                } else if (typeof raw === 'string' && raw) {
                    availableProducts = raw.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
                }
            }

            return {
                coupon_no: c.coupon_no,
                coupon_name: c.coupon_name,
                benefit_type: c.benefit_type,
                benefit_percentage: c.benefit_percentage ? parseFloat(c.benefit_percentage) : null,
                benefit_price: c.benefit_price ? Math.floor(parseFloat(c.benefit_price)) : null,
                available_date: c.available_date || '',
                available_product_type: availableProductType,
                available_product: availableProducts
            };
        });

        res.json({ success: true, count: enriched.length, data: enriched });
    } catch (error) { res.status(500).json({ success: false, message: 'Cafe24 Coupon API Error' }); }
});

app.get('/api/cafe24/coupons/:couponNo', async (req, res) => {
    try {
        const { couponNo } = req.params;
        const fetchFromCafe24 = async (url, params, retry = false) => {
            try {
                return await axios.get(url, {
                    params,
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                });
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) {
                    await refreshAccessToken(); return await fetchFromCafe24(url, params, true);
                }
                throw err;
            }
        };

        const couponRes = await fetchFromCafe24(`https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`, { shop_no: 1, coupon_no: couponNo });
        const coupon = (couponRes.data.coupons || [])[0];
        if (!coupon) return res.status(404).json({ success: false, message: '쿠폰 없음' });

        const productNos = coupon.available_product_list || [];
        let productDetails = [];
        
        if (productNos.length > 0) {
            try {
                const chunkSize = 100;
                for (let i = 0; i < productNos.length; i += chunkSize) {
                    const chunk = productNos.slice(i, i + chunkSize);
                    const productRes = await fetchFromCafe24(
                        `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                        { shop_no: 1, product_no: chunk.join(','), fields: 'product_no,product_name,price,detail_image,list_image,small_image', limit: 100 }
                    );
                    const chunkDetails = (productRes.data.products || []).map(p => ({
                        product_no: p.product_no, product_name: p.product_name, price: Math.floor(Number(p.price)), image: p.detail_image || p.list_image || p.small_image || ''
                    }));
                    productDetails = productDetails.concat(chunkDetails);
                }
            } catch (e) {
                productDetails = productNos.map(no => ({ product_no: no, product_name: `상품 #${no}`, price: 0, image: '' }));
            }
        }

        res.json({
            success: true, 
            data: {
                coupon_no: coupon.coupon_no, coupon_name: coupon.coupon_name, benefit_type: coupon.benefit_type,
                benefit_percentage: coupon.benefit_percentage ? parseFloat(coupon.benefit_percentage) : null,
                benefit_price: coupon.benefit_price ? Math.floor(parseFloat(coupon.benefit_price)) : null,
                available_product_type: coupon.available_product || 'A', available_product_list: productNos, products: productDetails
            }
        });
    } catch (error) { res.status(500).json({ success: false, message: 'Cafe24 Coupon API Error' }); }
});

app.post('/api/coupon-map', async (req, res) => {
    try {
        const { coupon_no, coupon_name, benefit_type, benefit_percentage, benefit_price, start_date, end_date, products } = req.body;
        if (!coupon_no) return res.status(400).json({ success: false });

        await db.collection(COLLECTION_COUPON_MAP).updateOne(
            { coupon_no: String(coupon_no) },
            { $set: { coupon_no: String(coupon_no), coupon_name, benefit_type, benefit_percentage, benefit_price, start_date, end_date, products, updated_at: new Date() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/coupon-map', async (req, res) => {
    try {
        const mappings = await db.collection(COLLECTION_COUPON_MAP).find({}).toArray();
        const today = new Date().toISOString().slice(0, 10);
        const active = mappings.filter(m => !m.end_date || m.end_date >= today);
        res.json({ success: true, data: active });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/coupon-map/:couponNo', async (req, res) => {
    try {
        await db.collection(COLLECTION_COUPON_MAP).deleteOne({ coupon_no: String(req.params.couponNo) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ==========================================
// [6] 주문 데이터 CRUD
// ==========================================
app.get('/api/ordersOffData', async (req, res) => {
    try {
        const { store_name, startDate, endDate, keyword, view } = req.query;
        let query = {};

        if (view === 'trash') {
            query.is_deleted = true;
        } else if (view === 'completed') {
            query.is_deleted = { $ne: true };
            query.$or = [
                { status: ORDER_STATUS.CONFIRMED },
                { status: { $exists: false }, is_synced: true }
            ];
        } else if (view === 'exported') {
            query.is_deleted = { $ne: true };
            query.status = ORDER_STATUS.EXPORTED;
        } else if (view === 'failed') {
            query.is_deleted = { $ne: true };
            query.status = ORDER_STATUS.FAILED;
        } else {
            query.is_deleted = { $ne: true };
            query.$or = [
                { status: ORDER_STATUS.PENDING },
                { status: { $exists: false }, is_synced: { $ne: true } }
            ];
        }

        if (store_name && store_name !== '전체' && store_name !== 'null') query.store_name = store_name;
        if (startDate && endDate) query.created_at = { $gte: new Date(startDate + "T00:00:00.000Z"), $lte: new Date(endDate + "T23:59:59.999Z") };
        if (keyword) {
            const keywordOr = [
                { customer_name: { $regex: keyword, $options: 'i' } },
                { customer_phone: { $regex: keyword, $options: 'i' } },
                { product_name: { $regex: keyword, $options: 'i' } }
            ];
            if (query.$or) {
                query.$and = [{ $or: query.$or }, { $or: keywordOr }];
                delete query.$or;
            } else {
                query.$or = keywordOr;
            }
        }
        
        const orders = await db.collection(COLLECTION_ORDERS).find(query).sort({ created_at: -1 }).toArray();

        // 🆕 각 주문의 메모(댓글) 카운트 집계 → 메모 있는 행 시각 강조용
        if (orders.length > 0) {
            const orderIds = orders.map(o => String(o._id));
            const memoAgg = await db.collection(COLLECTION_CS_MEMOS).aggregate([
                { $match: { order_id: { $in: orderIds } } },
                { $group: { _id: '$order_id', count: { $sum: 1 } } }
            ]).toArray();
            const memoMap = new Map(memoAgg.map(m => [m._id, m.count]));
            orders.forEach(o => { o.memo_count = memoMap.get(String(o._id)) || 0; });
        }

        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) {
        console.error("🔥 주문 조회 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/ordersOffData', authMiddleware, async (req, res) => {
    try {
        const d = req.body;
        
        let items = (d.items || []).map(it => ({
            product_no: it.product_no, 
            product_name: it.product_name || d.product_name,
            option_code: it.option_code, 
            option_name: it.option_name || d.option_name,
            original_price: Number(it.original_price) || 0,
            price: Number(it.price) || 0,
            quantity: Number(it.quantity) || 1,
            promo_type: it.promo_type || ''
        }));

        if (items.length === 0) {
            items = [{ product_name: d.product_name, option_name: d.option_name, price: 0, original_price: 0, quantity: 1, promo_type: '' }];
        }

        const newOrder = {
            ...d, 
            items,
            total_amount: Number(d.total_amount) || 0,
            shipping_cost: Number(d.shipping_cost) || 0,
            total_discount_amount: Number(d.total_discount_amount) || 0,
            applied_coupon_count: Number(d.applied_coupon_count) || 0,
            status: ORDER_STATUS.PENDING,
            is_synced: false, 
            is_deleted: false,
            created_at: new Date(), 
            synced_at: null, 
            ecount_success: null
        };
        delete newOrder._id;
        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, orderId: result.insertedId });
    } catch (error) {
        console.error("🔥 주문 생성 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.put('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
        const f = { ...req.body, updated_at: new Date() };
        delete f._id;
        
        if (f.shipping_cost !== undefined) f.shipping_cost = Number(f.shipping_cost);
        if (f.total_amount !== undefined) f.total_amount = Number(f.total_amount);
        if (f.total_discount_amount !== undefined) f.total_discount_amount = Number(f.total_discount_amount);
        if (f.applied_coupon_count !== undefined) f.applied_coupon_count = Number(f.applied_coupon_count);

        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(req.params.id) }, { $set: f });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
        if (req.query.type === 'hard') await db.collection(COLLECTION_ORDERS).deleteOne({ _id: new ObjectId(req.params.id) });
        else await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(req.params.id) }, { $set: { is_deleted: true, deleted_at: new Date() } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/ordersOffData/restore/:id', authMiddleware, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
        await db.collection(COLLECTION_ORDERS).updateOne(
            { _id: new ObjectId(req.params.id) },
            { 
                $set: { 
                    is_deleted: false, 
                    deleted_at: null, 
                    is_synced: false, 
                    synced_at: null, 
                    ecount_status: null, 
                    ecount_message: null,
                    status: ORDER_STATUS.PENDING,
                    excel_batch_id: null,
                    excel_downloaded_at: null,
                    ecount_confirmed_at: null,
                    ecount_failed_at: null
                } 
            }
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 🟡 [기존 호환] /sync 엔드포인트
app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const { results } = req.body; 
        if (!results || !Array.isArray(results)) return res.status(400).json({ success: false });
        const bulkOps = results.map(item => ({
            updateOne: {
                filter: { _id: new ObjectId(item.id) },
                update: { 
                    $set: { 
                        is_synced: true, 
                        synced_at: new Date(), 
                        ecount_success: item.status === 'SUCCESS', 
                        ecount_message: item.message || '',
                        status: item.status === 'SUCCESS' ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.FAILED,
                        ...(item.status === 'SUCCESS' 
                            ? { ecount_confirmed_at: new Date() } 
                            : { ecount_failed_at: new Date(), ecount_failure_reason: item.message || '' })
                    } 
                }
            }
        }));
        if (bulkOps.length > 0) await db.collection(COLLECTION_ORDERS).bulkWrite(bulkOps);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/ordersOffData/sync-by-content', async (req, res) => {
    try {
        const { results } = req.body;
        if (!results || !Array.isArray(results)) return res.status(400).json({ success: false });
        for (const item of results) {
            const amount = typeof item.matchKey.total_amount === 'string' ? Number(item.matchKey.total_amount.replace(/,/g, '')) : item.matchKey.total_amount;
            await db.collection(COLLECTION_ORDERS).updateOne(
                { is_synced: { $ne: true }, customer_name: item.matchKey.customer_name, total_amount: amount },
                { 
                    $set: { 
                        is_synced: true, 
                        synced_at: new Date(), 
                        ecount_success: item.status === 'SUCCESS', 
                        ecount_message: item.message || '',
                        status: item.status === 'SUCCESS' ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.FAILED,
                        ...(item.status === 'SUCCESS' 
                            ? { ecount_confirmed_at: new Date() } 
                            : { ecount_failed_at: new Date(), ecount_failure_reason: item.message || '' })
                    } 
                }
            );
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});
// ==========================================
// 🆕 [6-2] 주문 상태 머신 신규 API (매크로 실행 기반 자동 복구 추가)
// ==========================================
app.post('/api/ordersOffData/mark-exported', async (req, res) => {
    try {
        const { orderIds } = req.body;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'orderIds가 필요합니다.' });
        }

        const validIds = orderIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        if (validIds.length === 0) {
            return res.status(400).json({ success: false, message: '유효한 주문 ID가 없습니다.' });
        }

        // ------------------------------------------------------------------
        // 🔥 [추가된 로직] 매크로 실행 기반 "방치 카운트" 증가 및 3회 이상 시 롤백
        // ------------------------------------------------------------------
        
        // 1. 이번 엑셀 다운로드에 포함되지 않은 '기존 확정대기(EXPORTED)' 주문들의 누락 횟수 1 증가
        await db.collection(COLLECTION_ORDERS).updateMany(
            {
                status: ORDER_STATUS.EXPORTED,
                _id: { $nin: validIds }, // 이번에 다운받는 건 제외
                is_deleted: { $ne: true }
            },
            { $inc: { macro_miss_count: 1 } }
        );

        // 2. 누락 횟수(macro_miss_count)가 3 이상인 주문들을 미전송(PENDING)으로 복구
        const autoRequeueResult = await db.collection(COLLECTION_ORDERS).updateMany(
            {
                status: ORDER_STATUS.EXPORTED,
                macro_miss_count: { $gte: 1 }, // 최대 3회 매크로 실행 동안 방치된 건
                is_deleted: { $ne: true }
            },
            {
                $set: {
                    status: ORDER_STATUS.PENDING, // 미전송으로 복구
                    auto_requeued: true,
                    auto_requeued_at: new Date(),
                    macro_miss_count: 0, // 초기화 (다음 다운로드 때 다시 정상 포함되도록)
                    is_synced: false,
                    synced_at: null,
                    ecount_success: null,
                    excel_batch_id: null,
                    excel_downloaded_at: null
                },
                $inc: { auto_requeue_count: 1 }
            }
        );

        if (autoRequeueResult.modifiedCount > 0) {
            console.log(`[MACRO-REQUEUE] 매크로 1회 누락으로 인해 ${autoRequeueResult.modifiedCount}건 미전송(PENDING)으로 자동 복구됨`);
        }
        // ------------------------------------------------------------------

        // 3. [기존 로직] 이번에 다운로드할 주문들을 EXPORTED로 상태 변경
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const distinctBatches = await db.collection(COLLECTION_ORDERS).distinct('excel_batch_id', {
            excel_batch_id: { $regex: `^BATCH_${today}_` }
        });
        const seq = String(distinctBatches.length + 1).padStart(3, '0');
        const batchId = `BATCH_${today}_${seq}`;

        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            {
                _id: { $in: validIds },
                is_deleted: { $ne: true },
                $or: [
                    { status: ORDER_STATUS.PENDING },
                    { status: { $exists: false }, is_synced: { $ne: true } }
                ]
            },
            {
                $set: {
                    status: ORDER_STATUS.EXPORTED,
                    excel_batch_id: batchId,
                    excel_downloaded_at: new Date(),
                    macro_miss_count: 0 // 새로 확정대기가 된 건 카운트 0으로 시작
                }
            }
        );

        res.json({
            success: true,
            batchId,
            markedCount: result.modifiedCount,
            requestedCount: orderIds.length,
            skippedCount: orderIds.length - result.modifiedCount,
            requeuedFromStale: autoRequeueResult.modifiedCount // 프론트에 롤백 건수도 알려주면 좋습니다
        });
    } catch (error) {
        console.error("🔥 mark-exported 오류:", error);
        res.status(500).json({ success: false, message: '서버 오류' });
    }
});

app.post('/api/ordersOffData/confirm-batch', async (req, res) => {
    try {
        const { batchId } = req.body;
        if (!batchId) return res.status(400).json({ success: false, message: 'batchId가 필요합니다.' });

        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { excel_batch_id: batchId, status: ORDER_STATUS.EXPORTED },
            {
                $set: {
                    status: ORDER_STATUS.CONFIRMED,
                    ecount_confirmed_at: new Date(),
                    is_synced: true,
                    synced_at: new Date(),
                    ecount_success: true
                }
            }
        );

        res.json({ success: true, confirmedCount: result.modifiedCount });
    } catch (error) {
        console.error("🔥 confirm-batch 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/ordersOffData/confirm-selected', async (req, res) => {
    try {
        const { orderIds } = req.body;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'orderIds가 필요합니다.' });
        }

        const validIds = orderIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));

        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { _id: { $in: validIds }, status: ORDER_STATUS.EXPORTED },
            {
                $set: {
                    status: ORDER_STATUS.CONFIRMED,
                    ecount_confirmed_at: new Date(),
                    is_synced: true,
                    synced_at: new Date(),
                    ecount_success: true
                }
            }
        );

        res.json({ success: true, confirmedCount: result.modifiedCount });
    } catch (error) {
        console.error("🔥 confirm-selected 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/ordersOffData/mark-failed', async (req, res) => {
    try {
        const { orderIds, reason } = req.body;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'orderIds가 필요합니다.' });
        }

        const validIds = orderIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        const failureReason = reason || '이카운트 등록 실패';

        const orders = await db.collection(COLLECTION_ORDERS).find(
            { _id: { $in: validIds }, status: ORDER_STATUS.EXPORTED }
        ).toArray();

        if (orders.length === 0) {
            return res.json({ success: true, failedCount: 0, message: '처리 대상 없음' });
        }

        const bulkOps = orders.map(o => ({
            updateOne: {
                filter: { _id: o._id },
                update: {
                    $set: {
                        status: ORDER_STATUS.FAILED,
                        ecount_failed_at: new Date(),
                        ecount_failure_reason: failureReason,
                        is_synced: true,
                        synced_at: new Date(),
                        ecount_success: false,
                        ecount_message: failureReason
                    },
                    $inc: { retry_count: 1 },
                    $push: {
                        retry_history: {
                            batch_id: o.excel_batch_id || null,
                            failed_at: new Date(),
                            reason: failureReason
                        }
                    }
                }
            }
        }));

        const result = await db.collection(COLLECTION_ORDERS).bulkWrite(bulkOps);
        res.json({ success: true, failedCount: result.modifiedCount });
    } catch (error) {
        console.error("🔥 mark-failed 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/ordersOffData/requeue', async (req, res) => {
    try {
        const { orderIds } = req.body;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'orderIds가 필요합니다.' });
        }

        const validIds = orderIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));

        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { _id: { $in: validIds }, status: ORDER_STATUS.FAILED },
            {
                $set: {
                    status: ORDER_STATUS.PENDING,
                    is_synced: false,
                    synced_at: null,
                    ecount_success: null,
                    ecount_message: null,
                    excel_batch_id: null,
                    excel_downloaded_at: null,
                    ecount_failed_at: null
                }
            }
        );

        res.json({ success: true, requeuedCount: result.modifiedCount });
    } catch (error) {
        console.error("🔥 requeue 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/ordersOffData/batches', async (req, res) => {
    try {
        const batches = await db.collection(COLLECTION_ORDERS).aggregate([
            { 
                $match: { 
                    status: ORDER_STATUS.EXPORTED, 
                    is_deleted: { $ne: true } 
                } 
            },
            {
                $group: {
                    _id: '$excel_batch_id',
                    count: { $sum: 1 },
                    downloadedAt: { $first: '$excel_downloaded_at' },
                    totalAmount: { $sum: '$total_amount' },
                    stores: { $addToSet: '$store_name' }
                }
            },
            { $sort: { downloadedAt: -1 } }
        ]).toArray();

        res.json({ success: true, data: batches });
    } catch (error) {
        console.error("🔥 batches 조회 오류:", error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/ordersOffData/counts', async (req, res) => {
    try {
        const [pending, exported, failed] = await Promise.all([
            db.collection(COLLECTION_ORDERS).countDocuments({
                is_deleted: { $ne: true },
                $or: [
                    { status: ORDER_STATUS.PENDING },
                    { status: { $exists: false }, is_synced: { $ne: true } }
                ]
            }),
            db.collection(COLLECTION_ORDERS).countDocuments({
                is_deleted: { $ne: true },
                status: ORDER_STATUS.EXPORTED
            }),
            db.collection(COLLECTION_ORDERS).countDocuments({
                is_deleted: { $ne: true },
                status: ORDER_STATUS.FAILED
            })
        ]);

        res.json({ success: true, data: { pending, exported, failed } });
    } catch (error) {
        console.error("🔥 counts 조회 오류:", error);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 🆕 [6-3] 자동 복구 (Stale EXPORTED → PENDING)
// ==========================================

/**
 * 🆕 핵심 자동 복구 로직 (재사용 가능한 함수)
 * - status: EXPORTED + downloaded_at이 30분 이상 경과 + auto_requeued !== true
 * - 1회만 자동 복구 (auto_requeued: true 플래그로 무한 루프 방지)
 */
async function performAutoRequeue() {
    try {
        if (!db) return { requeuedCount: 0, targets: [] };
        
        const staleThreshold = new Date(Date.now() - AUTO_REQUEUE_STALE_MINUTES * 60 * 1000);

        // 1. 대상 조회
        const targets = await db.collection(COLLECTION_ORDERS).find({
            status: ORDER_STATUS.EXPORTED,
            excel_downloaded_at: { $lte: staleThreshold, $ne: null },
            auto_requeued: { $ne: true },
            is_deleted: { $ne: true }
        }).project({
            _id: 1, store_name: 1, customer_name: 1,
            excel_batch_id: 1, excel_downloaded_at: 1, total_amount: 1
        }).toArray();

        if (targets.length === 0) {
            return { requeuedCount: 0, targets: [] };
        }

        const targetIds = targets.map(t => t._id);

        // 2. 일괄 업데이트
        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { _id: { $in: targetIds } },
            {
                $set: {
                    status: ORDER_STATUS.PENDING,
                    auto_requeued: true,                     // 🔥 1회 제한 플래그
                    auto_requeued_at: new Date(),
                    is_synced: false,
                    synced_at: null,
                    ecount_success: null,
                    ecount_message: null,
                    excel_batch_id: null,
                    excel_downloaded_at: null
                },
                $inc: { auto_requeue_count: 1 }
            }
        );

        // 3. 로깅
        console.log(`[AUTO-REQUEUE] ${new Date().toISOString()} - ${result.modifiedCount}건 자동 복구`);
        targets.forEach(t => {
            console.log(`  └ ${t.store_name} | ${t.customer_name} | batch:${t.excel_batch_id}`);
        });

        return { requeuedCount: result.modifiedCount, targets };
    } catch (err) {
        console.error('[AUTO-REQUEUE ERROR]', err);
        return { requeuedCount: 0, targets: [], error: err.message };
    }
}

/**
 * 🆕 [POST] 수동 트리거 (프론트엔드에서 호출)
 */
app.post('/api/ordersOffData/auto-requeue', async (req, res) => {
    const result = await performAutoRequeue();
    if (result.error) {
        return res.status(500).json({ success: false, message: result.error });
    }
    res.json({
        success: true,
        requeuedCount: result.requeuedCount,
        targets: result.targets,
        staleMinutes: AUTO_REQUEUE_STALE_MINUTES,
        message: result.requeuedCount > 0
            ? `${result.requeuedCount}건이 ${AUTO_REQUEUE_STALE_MINUTES}분 이상 미처리되어 미전송 상태로 자동 복구되었습니다.`
            : '복구 대상 없음'
    });
});

/**
 * 🆕 [GET] 복구 대상 미리보기 (실제 복구 X, 모니터링용)
 */
app.get('/api/ordersOffData/auto-requeue/check', async (req, res) => {
    try {
        const staleThreshold = new Date(Date.now() - AUTO_REQUEUE_STALE_MINUTES * 60 * 1000);
        const count = await db.collection(COLLECTION_ORDERS).countDocuments({
            status: ORDER_STATUS.EXPORTED,
            excel_downloaded_at: { $lte: staleThreshold, $ne: null },
            auto_requeued: { $ne: true },
            is_deleted: { $ne: true }
        });
        res.json({ success: true, count, staleMinutes: AUTO_REQUEUE_STALE_MINUTES });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 🆕 자동 복구 cron (3분 간격, setInterval 사용)
 */
function startAutoRequeueCron() {
    const INTERVAL_MS = 3 * 60 * 1000; // 3분

    setInterval(async () => {
        const result = await performAutoRequeue();
        if (result.requeuedCount > 0) {
            console.log(`[CRON AUTO-REQUEUE] ✅ ${result.requeuedCount}건 자동 복구 완료`);
        }
    }, INTERVAL_MS);

    console.log(`✅ Auto-Requeue Cron 등록 완료 (3분 간격, ${AUTO_REQUEUE_STALE_MINUTES}분 이상 미처리 건 대상)`);
}

// ==========================================
// [7] 정적 데이터 (매장, 창고, 담당자 등)
// ==========================================
// 🆕 매핑 모듈 (예: matchItemCode) - 미리 require해서 다른 핸들러에서도 안전하게 사용
const { matchItemCode: _matchItemCodeReq } = require('./utils/itemMatcher');

// 🆕 ITEM_CAFE24.json 조회 (매핑 체크 페이지용)
app.get('/api/item-cafe24', (req, res) => {
    const filePath = path.join(__dirname, 'ITEM_CAFE24.json');
    if (!fs.existsSync(filePath)) return res.json({ success: true, count: 0, data: [] });
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json({ success: true, count: data.length, data });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 🆕 매핑 체크: ITEM_CAFE24 × ITEM_CODES 전체 매칭 결과 일괄 계산
// 🆕 매핑체크 — 사전 계산된 MAPPING_RESULT.json 정적 서빙 (런타임 계산 X)
//    JSON 갱신 방법: `node buildMappingCheck.js` 실행 후 서버에 푸시
app.get('/api/admin/mapping-check', (req, res) => {
    const resultPath = path.join(__dirname, 'MAPPING_RESULT.json');
    if (!fs.existsSync(resultPath)) {
        return res.status(404).json({
            success: false,
            message: 'MAPPING_RESULT.json 없음. 로컬에서 `node buildMappingCheck.js` 실행 후 서버에 푸시하세요.'
        });
    }
    try {
        const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/item-codes', (req, res) => {
    const filePath = path.join(__dirname, 'ITEM_CODES.json');
    if (!fs.existsSync(filePath)) return res.json({ success: true, count: 0, data: [] });
    try { res.json({ success: true, count: JSON.parse(fs.readFileSync(filePath, 'utf-8')).length, data: JSON.parse(fs.readFileSync(filePath, 'utf-8')) }); }
    catch { res.json({ success: true, count: 0, data: [] }); }
});

app.get('/api/ecount-stores', async (req, res) => {
    const stores = await db.collection(COLLECTION_STORES).find({}).toArray();
    res.json({ success: true, data: stores });
});
app.put('/api/ecount-stores', async (req, res) => {
    await db.collection(COLLECTION_STORES).deleteMany({});
    if(req.body.data.length > 0) await db.collection(COLLECTION_STORES).insertMany(req.body.data.map(i => ({...i, updated_at: new Date()})));
    res.json({ success: true });
});

app.get('/api/static-managers', async (req, res) => {
    const managers = await db.collection(COLLECTION_STATIC_MANAGERS).find({}).toArray();
    res.json({ success: true, data: managers });
});
app.put('/api/static-managers', async (req, res) => {
    await db.collection(COLLECTION_STATIC_MANAGERS).deleteMany({});
    if(req.body.data.length > 0) await db.collection(COLLECTION_STATIC_MANAGERS).insertMany(req.body.data.map(i => ({...i, updated_at: new Date()})));
    res.json({ success: true });
});

app.get('/api/ecount-warehouses', async (req, res) => {
    const warehouses = await db.collection(COLLECTION_WAREHOUSES).find({}).toArray();
    res.json({ success: true, data: warehouses });
});
app.put('/api/ecount-warehouses', async (req, res) => {
    await db.collection(COLLECTION_WAREHOUSES).deleteMany({});
    if(req.body.data.length > 0) await db.collection(COLLECTION_WAREHOUSES).insertMany(req.body.data.map(i => ({...i, updated_at: new Date()})));
    res.json({ success: true });
});

app.get('/api/cs-memos/:orderId', async (req, res) => {
    try {
        // 시간순(오래된 것부터)으로 정렬해 스레드 구성 용이
        const memos = await db.collection(COLLECTION_CS_MEMOS)
            .find({ order_id: req.params.orderId })
            .sort({ created_at: 1 })
            .toArray();
        res.json({ success: true, data: memos });
    } catch (e) { res.status(500).json({ success: false }); }
});

// 🆕 댓글/대댓글 등록 — parent_id 있으면 대댓글
app.post('/api/cs-memos', async (req, res) => {
    try {
        const { orderId, content, writer, parent_id } = req.body;
        if (!orderId || !content || !String(content).trim()) {
            return res.status(400).json({ success: false, message: 'orderId / content 필수' });
        }
        const doc = {
            order_id: orderId,
            content: String(content).trim(),
            writer: writer || '관리자',
            parent_id: parent_id || null,           // 🆕 대댓글이면 부모 메모 id
            created_at: new Date()
        };
        const r = await db.collection(COLLECTION_CS_MEMOS).insertOne(doc);
        res.json({ success: true, insertedId: r.insertedId, data: { ...doc, _id: r.insertedId } });
    } catch (e) {
        console.error('🔥 cs-memos POST 오류:', e);
        res.status(500).json({ success: false });
    }
});

// 댓글 삭제 — 부모 삭제 시 대댓글도 함께 삭제
app.delete('/api/cs-memos/:id', async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
        const id = new ObjectId(req.params.id);
        // 부모 + 자식 모두 삭제
        const r = await db.collection(COLLECTION_CS_MEMOS).deleteMany({
            $or: [{ _id: id }, { parent_id: req.params.id }]
        });
        res.json({ success: true, deletedCount: r.deletedCount });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ==========================================
// [신규] 주문 메모 업데이트 API
// ==========================================
app.patch('/api/ordersOffData/:id/memo', async (req, res) => {
    try {
        const { id } = req.params;
        const { cs_memo } = req.body;
        
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: '잘못된 주문 ID입니다.' });
        }
        
        await db.collection(COLLECTION_ORDERS).updateOne(
            { _id: new ObjectId(id) },
            { $set: { cs_memo: cs_memo, updated_at: new Date() } }
        );
        
        res.json({ success: true, message: '메모가 업데이트되었습니다.' });
    } catch (error) {
        console.error('🔥 메모 업데이트 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류' });
    }
});

// ==========================================
// 맵핑 테스트 작업
// ==========================================
const { matchItemCode } = require('./utils/itemMatcher');

app.get('/api/admin/mapping-test-batch', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                    {
                        params: { shop_no: 1, display: 'T', selling: 'T', embed: 'options', limit: limit, offset: offset },
                        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                    }
                );
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) {
                    console.log("🔄 토큰 만료, 갱신 시도...");
                    await refreshAccessToken();
                    return await fetchFromCafe24(true);
                }
                throw err;
            }
        };

        console.log(`⏳ 매핑 테스트 배치 실행: offset ${offset} 부터 ${limit}개 요청...`);
        const response = await fetchFromCafe24();
        const products = response.data.products || [];

        const results = {
            successCount: 0,
            warningCount: 0,
            failCount: 0,
            details: [],
            hasMore: products.length === limit,
            nextOffset: offset + limit
        };

        const excludeKeywords = [
            '한정수량특가',
            'LAST CHANCE',
            '리퍼 한정수량',
            '무료배송',
            '하늘이네 공동구매'
        ];

        for (const prod of products) {
            const isOnlineOnly = excludeKeywords.some(kw => prod.product_name.includes(kw));
            if (isOnlineOnly) continue;

            const options = prod.options && prod.options.length > 0 ? prod.options : [{ option_name: '' }];
            
            for (const opt of options) {
                const matchResult = matchItemCode(prod.product_name, opt.option_name);
                
                const record = {
                    product_no: prod.product_no,
                    cafe24_name: prod.product_name,
                    cafe24_option: opt.option_name,
                    mapped_code: matchResult.code,
                    score: matchResult.score,
                    status: matchResult.status
                };

                if (matchResult.status === 'SUCCESS' || matchResult.status === 'EXCEPTION') results.successCount++;
                else if (matchResult.status === 'WARNING') results.warningCount++;
                else results.failCount++;

                results.details.push(record);
            }
        }

        results.details.sort((a, b) => a.score - b.score);
        res.json({ success: true, summary: results });

    } catch (error) {
        console.error("🔥 Mapping Test Batch Error:", error.message);
        res.status(500).json({ success: false, message: "서버 매핑 처리 중 오류가 발생했습니다." });
    }
});

// ==========================================
// [신규] 수동 확정대기 -> 미등록 강제 이동 API (매니저 권한 재전송)
// ==========================================
app.post('/api/ordersOffData/force-pending', async (req, res) => {
    try {
        const { orderIds } = req.body;
        let filter = { 
            status: ORDER_STATUS.EXPORTED, 
            is_deleted: { $ne: true } 
        };

        // 프론트에서 특정 주문(들)의 ID를 넘기면 해당 주문만, 안 넘기면 전체 확정대기 주문을 대상으로 함
        if (orderIds && Array.isArray(orderIds)) {
            if (orderIds.length === 0) {
                return res.json({ success: true, modifiedCount: 0, message: '선택된 주문이 없습니다.' });
            }
            const validIds = orderIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
            filter._id = { $in: validIds };
        }

        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            filter,
            {
                $set: {
                    status: ORDER_STATUS.PENDING,
                    is_synced: false,
                    synced_at: null,
                    ecount_success: null,
                    ecount_message: null,
                    excel_batch_id: null,
                    excel_downloaded_at: null,
                    auto_requeued: false, // 다음 매크로 누락 시 다시 자동복구가 탈 수 있도록 초기화
                    macro_miss_count: 0
                }
            }
        );

        res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (error) {
        console.error("🔥 강제 미등록 이동 오류:", error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});


// ==========================================
// 🚚 [7-2] 출하 매핑 (deliveryList.xlsx 기반)
// - 프론트에서 SheetJS로 파싱한 JSON을 받아 DB에 저장
// - 매장 + 고객명으로 등록완료(CONFIRMED) 주문에 매핑하여 출하상태 조회
// ==========================================
const REQUIRED_DELIVERY_COLS = ['매장', '운송장번호', '택배사', '주문번호', '출하일자', '이름', '품명'];

function normalizeName(s) {
    return String(s || '').replace(/\s+/g, '').trim();
}

// 전화번호 정규화: 숫자만 추출 (동명인 구분용)
function normalizePhone(s) {
    return String(s || '').replace(/\D/g, '');
}

function classifyShipDate(raw) {
    if (raw === null || raw === undefined || raw === '') {
        return { status: 'EMPTY', shipDate: null, raw: '' };
    }
    const s = String(raw).trim();
    if (!s) return { status: 'EMPTY', shipDate: null, raw: '' };

    if (s.includes('출고보류')) return { status: 'HOLD', shipDate: null, raw: s };
    if (s.includes('재고소진')) return { status: 'OUT_OF_STOCK', shipDate: null, raw: s };

    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        return { status: 'SHIPPED', shipDate: d, raw: s };
    }
    return { status: 'OTHER', shipDate: null, raw: s };
}

// ==========================================
// 🔍 상품명 매칭 헬퍼 (주문 vs 출하 품명 비교) — 토큰 단위 매칭
// ==========================================

// 텍스트를 의미 있는 단어 토큰들로 분해
// "요기보 라운저 프리미엄_라이트그레이" → ["요기보","라운저","프리미엄","라이트그레이"]
// "메가문필로우(스탠다드)_아쿠아블루" → ["메가문필로우","아쿠아블루"]  (괄호내 메타데이터 무시)
function tokenizeProduct(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')         // 🔥 괄호 내용 제거 (스탠다드/쿠션/사이즈 등 메타)
        .replace(/\[[^\]]*\]/g, ' ')        // 🔥 대괄호 내용 제거
        .replace(/[#\(\)\[\]\-\+.,_\/]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 0);
}

// 출하 품명 파싱 → 품목별 토큰 배열
// "롤맥스프리미엄_아보카도그린/코지보트래블_아쿠아블루_#3"
//   → [{tokens:["롤맥스프리미엄","아보카도그린"], raw:"..."},
//      {tokens:["코지보트래블","아쿠아블루"],    raw:"..."}]
// 끝의 _#1, _#5, _#BT 같은 마커 모두 제거
function extractShipmentPieces(shipmentText) {
    let text = String(shipmentText || '').trim();
    if (!text) return [];
    // _#숫자 또는 _#영문(BT, BS 등 운송 마커) 모두 제거
    text = text.replace(/_#[A-Za-z0-9]+\s*$/, '');
    // 슬래시로 다중 품목 분리하되, 각 조각에도 _#마커가 끝에 붙어있을 수 있음
    return text.split('/')
        .map(p => p.replace(/_#[A-Za-z0-9]+\s*$/, '').trim())
        .map(p => ({ tokens: tokenizeProduct(p), raw: p }))
        .filter(p => p.tokens.length > 0);
}

// 배송비 등 가상상품(매칭 무시 대상) 판별
function isVirtualShippingItem(item) {
    if (!item) return false;
    const name = String(item.product_name || '').toLowerCase();
    const code = String(item.product_no || item.item_code || '').toUpperCase();
    if (name.includes('배송비')) return true;
    if (name.includes('delivery charge')) return true;
    if (name.includes('shipping')) return true;
    if (code.startsWith('SHIP_')) return true;
    if (code.startsWith('DA') && code.length <= 6) return true;   // DA0003 등
    if (code.startsWith('DB') && code.length <= 6) return true;   // DB0003 등
    return false;
}

// 주문 아이템 → 토큰 시그니처 배열 (수량 포함, 배송비 등 가상상품 제외)
function buildOrderItemSignatures(order) {
    const rawItems = Array.isArray(order.items) && order.items.length > 0
        ? order.items
        : [{ product_name: order.product_name, option_name: order.option_name }];

    // 🔥 배송비/Delivery Charge 항목은 실제 출고 대상이 아니므로 매칭에서 제외
    const items = rawItems.filter(it => !isVirtualShippingItem(it));

    return items.map(it => {
        const opt = it.option_name && it.option_name !== '.' ? it.option_name : '';
        const qty = Math.max(1, Number(it.quantity) || 1);
        const raw = `${it.product_name || ''} ${opt}`.trim();
        return {
            tokens: tokenizeProduct(raw),
            quantity: qty,
            raw
        };
    }).filter(it => it.tokens.length > 0);
}

// 두 토큰이 같은 의미인지 (정확일치 or 한쪽이 다른쪽을 포함)
// - 한글 단음절(롤, 닷, 미 등)도 의미있는 토큰이므로 허용
// - 영문/숫자는 2글자 이상 + 'L'/'M'/'S' 같은 사이즈는 정확일치만 (오버매칭 방지)
const HANGUL_RE = /[가-힯]/;
function tokenSimilar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const minOk = (s) => s.length >= 2 || HANGUL_RE.test(s);  // 한글이면 1글자도 OK
    if (minOk(a) && b.includes(a)) return true;
    if (minOk(b) && a.includes(b)) return true;
    return false;
}

// 출하 품목 토큰들이 주문 품목 토큰들에 "모두 포함"되면 매칭
function shipMatchesOrderItem(shipTokens, orderTokens) {
    return shipTokens.every(st => orderTokens.some(ot => tokenSimilar(st, ot)));
}

/**
 * 주문 ↔ 출하 매칭 결과
 *
 * 묶음 인식 룰:
 *  - 한 운송장에 여러 품목이 슬래시로 묶여있으면 묶음 배송
 *  - 운송장 내 품목 중 하나라도 주문과 매칭되면 → 같은 운송장의 나머지는 "묶음 동봉" 으로 처리 (정상)
 *  - 운송장 내 모든 품목이 매칭 안되면 → 진짜 잘못된 출고 (오배송/픽업)
 */
function matchOrderShipments(order, shipments) {
    const orderItems = buildOrderItemSignatures(order);
    const remaining = orderItems.map((it, idx) => ({ ...it, idx, remainingQty: it.quantity }));

    const matchedItems = [];
    const wrongShipItems = [];     // 같은 운송장에 매칭된 게 0건 → 잘못된 출고 (오배송 후보)
    const bundleCompanions = [];   // 같은 운송장에 매칭이 있음 → 묶음 동봉 (정상)
    let shipItemCount = 0;

    shipments.forEach(s => {
        const pieces = extractShipmentPieces(s.product_text);
        shipItemCount += pieces.length;

        const localUnmatched = [];
        let localMatchCount = 0;

        pieces.forEach(piece => {
            const matchIdx = remaining.findIndex(oi =>
                oi.remainingQty > 0 && shipMatchesOrderItem(piece.tokens, oi.tokens)
            );
            if (matchIdx >= 0) {
                remaining[matchIdx].remainingQty--;
                matchedItems.push({
                    raw: piece.raw,
                    matched_to: remaining[matchIdx].raw,
                    ship_status: s.ship_status
                });
                localMatchCount++;
            } else {
                localUnmatched.push(piece);
            }
        });

        // 운송장 단위 묶음 판정
        // 🆕 manually_verified가 true면 wrong으로 분류하지 않고 bundleCompanions로 처리 (정상 출고로 간주)
        const isManuallyVerified = !!s.manually_verified;
        localUnmatched.forEach(p => {
            const item = {
                raw: p.raw,
                ship_status: s.ship_status,
                tracking_no: s.tracking_no || ''
            };
            if (isManuallyVerified || localMatchCount > 0) {
                bundleCompanions.push(item);  // 수동 정상처리 OR 같은 운송장에 매칭 있음
                return;
            }
            // 🆕 폴백: 잔여 수량은 0이지만 토큰이 주문 항목과 일치 → 중복/스플릿 출고로 묶음 동봉 처리
            //         (예: 한 주문에 같은 상품 출하가 두 운송장으로 나뉘었을 때 1개는 wrong 처리되는 문제 해결)
            const tokenMatchesAnyOrderItem = orderItems.some(oi => shipMatchesOrderItem(p.tokens, oi.tokens));
            if (tokenMatchesAnyOrderItem) {
                bundleCompanions.push(item);
            } else {
                wrongShipItems.push(item);
            }
        });
    });

    const missingOrderItems = remaining
        .filter(oi => oi.remainingQty > 0)
        .map(oi => ({ raw: oi.raw, qty: oi.remainingQty }));

    const totalOrderQty = orderItems.reduce((s, oi) => s + oi.quantity, 0);

    return {
        shipped: shipments.some(s => s.ship_status === 'SHIPPED'),
        itemMatched: wrongShipItems.length === 0 && bundleCompanions.length === 0 && missingOrderItems.length === 0,
        matchedItems,
        wrongShipItems,
        bundleCompanions,
        missingOrderItems,
        orderItemCount: totalOrderQty,
        shipItemCount
    };
}

async function ensureDeliveryIndexes() {
    try {
        const col = db.collection(COLLECTION_DELIVERIES);
        await col.createIndex({ store_name_norm: 1, customer_name_norm: 1, customer_phone_norm: 1 });
        await col.createIndex({ tracking_no: 1 });
        await col.createIndex({ order_no: 1 });
        await col.createIndex({ uploaded_at: -1 });
        console.log("✅ Delivery 인덱스 확인 완료");
    } catch (e) {
        console.error("⚠️ Delivery 인덱스 오류:", e.message);
    }
}

// 서버 시작 시 인덱스 보장 - startServer 안에서 호출되지만 안전하게 lazy 호출
/**
 * 🚚 출하데이터 전체 교체 (snapshot replace)
 * - 엑셀이 누적 전체본이므로, 기존 출하 데이터를 비우고 새로 적재
 * - 청크 분할 업로드 시 첫 청크에서만 wipe 하도록 `replaceMode` 플래그 사용
 *   - replaceMode=true (또는 미지정+isFirstChunk=true): 기존 데이터 삭제 후 insert
 *   - replaceMode=false: 단순 append (이어붙이기)
 */
app.post('/api/deliveries/bulk-upload', async (req, res) => {
    try {
        const { rows, fileName, replaceMode, isFirstChunk, isLastChunk, totalChunks, chunkIndex } = req.body;
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: '업로드 데이터가 없습니다.' });
        }

        await ensureDeliveryIndexes();

        const uploadedAt = new Date();

        // 🔥 첫 청크일 때만 기존 데이터 wipe (전체 교체 모드)
        let wipedCount = 0;
        if (replaceMode !== false && (isFirstChunk === true || isFirstChunk === undefined)) {
            const wipe = await db.collection(COLLECTION_DELIVERIES).deleteMany({ _meta: { $exists: false } });
            wipedCount = wipe.deletedCount || 0;
            console.log(`[DELIVERY] 🗑️  기존 출하 데이터 ${wipedCount}건 삭제 후 재적재 시작`);
        }

        // 진행중 배치 ID는 메타에서 끌어오거나(추가 청크), 새로 발급(첫 청크)
        let batchId;
        if (isFirstChunk === false) {
            const meta = await db.collection(COLLECTION_DELIVERIES).findOne({ _meta: 'current_batch' });
            batchId = meta ? meta.batch_id : `DEL_${uploadedAt.getTime()}`;
        } else {
            batchId = `DEL_${uploadedAt.getFullYear()}${String(uploadedAt.getMonth()+1).padStart(2,'0')}${String(uploadedAt.getDate()).padStart(2,'0')}_${String(uploadedAt.getHours()).padStart(2,'0')}${String(uploadedAt.getMinutes()).padStart(2,'0')}${String(uploadedAt.getSeconds()).padStart(2,'0')}`;
            await db.collection(COLLECTION_DELIVERIES).updateOne(
                { _meta: 'current_batch' },
                { $set: { _meta: 'current_batch', batch_id: batchId, started_at: uploadedAt, file_name: fileName || null } },
                { upsert: true }
            );
        }

        let inserted = 0, skipped = 0;
        const docs = [];

        for (const r of rows) {
            const store = String(r['매장'] || '').trim();
            const name = String(r['이름'] || '').trim();
            if (!store || !name) { skipped++; continue; }

            const shipInfo = classifyShipDate(r['출하일자']);
            const phone = String(r['연락처'] || '').trim();

            docs.push({
                store_name: store,
                store_name_norm: normalizeName(store),
                tracking_no: String(r['운송장번호'] || '').trim(),
                courier: String(r['택배사'] || '').trim(),
                order_no: String(r['주문번호'] || '').trim(),
                ship_date_raw: shipInfo.raw,
                ship_date: shipInfo.shipDate,
                ship_status: shipInfo.status,
                customer_name: name,
                customer_name_norm: normalizeName(name),
                customer_phone: phone,
                customer_phone_norm: normalizePhone(phone),  // 🆕 동명인 구분
                product_text: String(r['품명'] || '').trim(),
                batch_id: batchId,
                source_file: fileName || null,
                uploaded_at: uploadedAt
            });
        }

        if (docs.length > 0) {
            const r = await db.collection(COLLECTION_DELIVERIES).insertMany(docs, { ordered: false });
            inserted = r.insertedCount || docs.length;
        }

        // 마지막 청크에서 최종 메타 확정
        if (isLastChunk === true || isLastChunk === undefined) {
            const totalNow = await db.collection(COLLECTION_DELIVERIES).countDocuments({ _meta: { $exists: false }, batch_id: batchId });
            await db.collection(COLLECTION_DELIVERIES).updateOne(
                { _meta: 'last_upload' },
                { $set: { _meta: 'last_upload', batch_id: batchId, file_name: fileName || null, uploaded_at: uploadedAt, row_count: totalNow } },
                { upsert: true }
            );
            await db.collection(COLLECTION_DELIVERIES).deleteOne({ _meta: 'current_batch' });
            console.log(`[DELIVERY] ✅ 전체 교체 완료: 신규 ${totalNow}건 (이전 ${wipedCount}건 삭제됨) | batch:${batchId}`);
        }

        res.json({
            success: true,
            batchId,
            inserted,
            skipped,
            totalRows: rows.length,
            wipedCount,
            mode: replaceMode === false ? 'append' : 'replace'
        });
    } catch (e) {
        console.error("🔥 출하 업로드 오류:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/deliveries/last-upload', async (req, res) => {
    try {
        const meta = await db.collection(COLLECTION_DELIVERIES).findOne({ _meta: 'last_upload' });
        const total = await db.collection(COLLECTION_DELIVERIES).countDocuments({ _meta: { $exists: false } });
        res.json({ success: true, data: meta || null, totalRecords: total });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 🆕 출하 수동 정상 처리 토글 (관리자가 오배송 오인 케이스를 정리)
app.post('/api/deliveries/verify', async (req, res) => {
    try {
        const { tracking_no, verified = true, note = '' } = req.body;
        if (!tracking_no) return res.status(400).json({ success: false, message: 'tracking_no 필요' });

        const filter = { tracking_no: String(tracking_no).trim() };
        if (verified) {
            const r = await db.collection(COLLECTION_DELIVERIES).updateMany(filter, {
                $set: {
                    manually_verified: true,
                    verified_at: new Date(),
                    verified_note: String(note || '')
                }
            });
            res.json({ success: true, modifiedCount: r.modifiedCount, verified: true });
        } else {
            const r = await db.collection(COLLECTION_DELIVERIES).updateMany(filter, {
                $unset: { manually_verified: '', verified_at: '', verified_note: '' }
            });
            res.json({ success: true, modifiedCount: r.modifiedCount, verified: false });
        }
    } catch (e) {
        console.error('🔥 verify 오류:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/deliveries/clear', async (req, res) => {
    try {
        const { batchId } = req.query;
        const filter = batchId ? { batch_id: batchId } : { _meta: { $exists: false } };
        const r = await db.collection(COLLECTION_DELIVERIES).deleteMany(filter);
        if (!batchId) {
            await db.collection(COLLECTION_DELIVERIES).deleteOne({ _meta: 'last_upload' });
        }
        res.json({ success: true, deletedCount: r.deletedCount });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

/**
 * 출하상황 조회 - 등록완료(CONFIRMED) 주문 + 매장+고객명 기준 출하 데이터 조인
 * Query: store_name, startDate, endDate, keyword, status (all|shipped|pending|hold|unmatched)
 */
app.get('/api/deliveries/shipping-status', async (req, res) => {
    try {
        const { store_name, startDate, endDate, keyword, status } = req.query;

        // 1) CONFIRMED 주문 조회 (등록 완료) — 픽업/매장직판 제외
        //    sales_type '0003' = 출고(픽업) — 출하 매핑 대상 아님
        //    sales_type '0001' = 출고(택배) — 매핑 대상
        //    + 고객정보(이름/전화) 빈값/공백 추가 거름
        const orderQuery = {
            is_deleted: { $ne: true },
            sales_type:     { $ne: '0003' },                     // 🆕 픽업 주문 제외 (핵심)
            customer_name:  { $type: 'string', $regex: /\S/ },   // 빈/공백/없음 모두 제외
            customer_phone: { $type: 'string', $regex: /\S/ },   // 전화 없는 건도 보조 제외
            $or: [
                { status: ORDER_STATUS.CONFIRMED },
                { status: { $exists: false }, is_synced: true }
            ]
        };
        if (store_name && store_name !== '전체' && store_name !== 'null') {
            orderQuery.store_name = store_name;
        }
        if (startDate && endDate) {
            orderQuery.created_at = {
                $gte: new Date(startDate + "T00:00:00.000Z"),
                $lte: new Date(endDate + "T23:59:59.999Z")
            };
        }
        if (keyword) {
            const kw = { $regex: keyword, $options: 'i' };
            orderQuery.$and = [
                { $or: orderQuery.$or },
                { $or: [
                    { customer_name: kw },
                    { customer_phone: kw },
                    { product_name: kw }
                ]}
            ];
            delete orderQuery.$or;
        }

        const orders = await db.collection(COLLECTION_ORDERS)
            .find(orderQuery)
            .sort({ created_at: -1 })
            .toArray();

        // 2) 출하 데이터 일괄 조회 (메모리 매핑이 빠름)
        const allShipments = await db.collection(COLLECTION_DELIVERIES)
            .find({ _meta: { $exists: false } })
            .toArray();

        // 매장+고객명+전화번호 기준 인덱싱 (동명인 구분)
        // 전화번호가 양쪽 모두 있을 때만 strict 매칭, 한 쪽이라도 없으면 매장+이름으로 fallback
        const shipMapStrict = new Map();   // store+name+phone
        const shipMapLoose  = new Map();   // store+name (전화 없는 출하용 fallback)
        for (const s of allShipments) {
            const storeKey = s.store_name_norm || normalizeName(s.store_name);
            const nameKey  = s.customer_name_norm || normalizeName(s.customer_name);
            const phoneKey = s.customer_phone_norm || normalizePhone(s.customer_phone);

            const looseKey  = `${storeKey}||${nameKey}`;
            const strictKey = `${looseKey}||${phoneKey}`;

            if (phoneKey) {
                if (!shipMapStrict.has(strictKey)) shipMapStrict.set(strictKey, []);
                shipMapStrict.get(strictKey).push(s);
            } else {
                // 출하에 전화 없으면 loose에만 등록
                if (!shipMapLoose.has(looseKey)) shipMapLoose.set(looseKey, []);
                shipMapLoose.get(looseKey).push(s);
            }
        }

        // 3) 주문에 출하정보 조인 + 상품명 매칭 검증
        //    매칭 키: 매장 + 고객명 + 전화번호 (동명인 구분)
        //    검증 키: 주문 items 상품명 vs 출하 품명 (오배송 판정)
        const enriched = orders.map(o => {
            const storeKey = normalizeName(o.store_name);
            const nameKey  = normalizeName(o.customer_name);
            const phoneKey = normalizePhone(o.customer_phone);

            let ships = [];
            if (phoneKey) {
                // 전화번호 strict 매칭 우선
                ships = shipMapStrict.get(`${storeKey}||${nameKey}||${phoneKey}`) || [];
            }
            // 전화번호 없거나 strict 매칭 실패 시 → loose (전화 없는 출하 row와 매칭)
            if (ships.length === 0) {
                ships = shipMapLoose.get(`${storeKey}||${nameKey}`) || [];
            }

            // 상품 매칭 분석
            const match = matchOrderShipments(o, ships);

            // 최종 상태 판정
            let shipStatus;
            let daysSinceShipped = null;

            if (ships.length === 0) {
                shipStatus = 'NOT_SHIPPED';          // 출하 기록 없음
            } else {
                const allShipped = ships.every(s => s.ship_status === 'SHIPPED');
                const anyHold    = ships.some(s => s.ship_status === 'HOLD');
                const anyShipped = ships.some(s => s.ship_status === 'SHIPPED');

                // 가장 최근 출하일 계산 (가장 늦게 나간 화물 기준으로 배송완료 판정)
                const shipDates = ships
                    .filter(s => s.ship_status === 'SHIPPED' && s.ship_date)
                    .map(s => new Date(s.ship_date));
                if (shipDates.length > 0) {
                    const latest = new Date(Math.max(...shipDates.map(d => d.getTime())));
                    daysSinceShipped = Math.floor((Date.now() - latest.getTime()) / 86400000);
                }

                // 🔥 분류 우선순위 (묶음 인식 적용):
                //    wrongShipItems = 운송장 전체가 주문과 안 맞는 경우만 (진짜 잘못된 출고)
                //    bundleCompanions = 같은 운송장에 매칭이 있어서 동봉된 것 (정상)
                //
                //    a) wrongShipItems 운송장 있음 → 실제 오배송 (운송장 통째로 잘못 분배)
                //    b) wrongShipItems 운송장 없음 → 픽업상품예상포함
                //    c) 묶음 동봉만 있음 → 정상 출하/배송 (별도 안내 없음)
                //    d) 미출하 항목 있음 + 출하된 건 정상 → PARTIAL
                const hasWrong   = match.wrongShipItems.length > 0;
                const hasBundle  = match.bundleCompanions.length > 0;
                const hasMissing = match.missingOrderItems.length > 0;
                const wrongHasTracking = match.wrongShipItems.some(w => w.tracking_no && String(w.tracking_no).trim() !== '');

                if (hasWrong && wrongHasTracking) {
                    shipStatus = 'MISMATCHED';       // 운송장 통째로 잘못 분배 → 실제 오배송
                } else if (hasWrong) {
                    shipStatus = 'PICKUP_INCLUDED';  // 운송장 없는 잘못된 출고 → 픽업 가능성
                } else if (anyHold && !anyShipped) {
                    shipStatus = 'HOLD';             // 모두 출고보류
                } else if (allShipped && !hasMissing) {
                    // 모든 출하 완료 + 주문 완전 일치
                    if (daysSinceShipped !== null && daysSinceShipped >= DELIVERY_ESTIMATE_DAYS) {
                        shipStatus = 'DELIVERED';    // 출하 3일+ → 배송완료(추정)
                    } else {
                        shipStatus = 'SHIPPED';      // 출하완료 (배송중)
                    }
                } else if (anyShipped) {
                    // 출하된 건 모두 정상 매칭이지만 미출하 항목 존재
                    shipStatus = 'PARTIAL';
                } else {
                    shipStatus = 'PENDING';          // 기타 (OTHER, EMPTY 등)
                }
            }

            return {
                ...o,
                ship_status_overall: shipStatus,
                days_since_shipped: daysSinceShipped,
                match_info: {
                    order_item_count: match.orderItemCount,
                    ship_item_count: match.shipItemCount,
                    matched_count: match.matchedItems.length,
                    wrong_ship_items: match.wrongShipItems.map(w => w.raw),
                    bundle_companions: match.bundleCompanions.map(b => b.raw),   // 🆕 묶음 동봉
                    missing_order_items: match.missingOrderItems.map(m => ({ raw: m.raw, qty: m.qty }))
                },
                shipments: ships.map(s => {
                    // 이 출하 row의 piece가 어디 속하는지 (wrong / bundle / matched)
                    const myPieces = extractShipmentPieces(s.product_text);
                    const isWrong = myPieces.some(p =>
                        match.wrongShipItems.some(w => w.raw === p.raw)
                    );
                    const isBundleCompanion = myPieces.some(p =>
                        match.bundleCompanions.some(b => b.raw === p.raw)
                    );
                    return {
                        tracking_no: s.tracking_no,
                        courier: s.courier,
                        order_no: s.order_no,
                        ship_date_raw: s.ship_date_raw,
                        ship_date: s.ship_date,
                        ship_status: s.ship_status,
                        product_text: s.product_text,
                        is_wrong_product: isWrong,            // ⚠️ 운송장 통째로 안 맞음 → 오배송/픽업 후보
                        is_bundle_companion: isBundleCompanion, // 📦 묶음 동봉 (정상)
                        manually_verified: !!s.manually_verified, // 🆕 수동 정상 처리
                        verified_note: s.verified_note || ''
                    };
                })
            };
        });

        // 🆕 3.5) Pass 2: 운송장 교차 검증 — 같은 운송장이 다른 주문에서 정상 매칭됐다면
        //        이 주문에서도 오배송이 아닌 묶음 동봉으로 강등 처리
        //        (e.g. 고객 X의 주문 O1=[A], O2=[B]. 운송장 T1=[A,C] → O2에서 A·C가 wrong 처리되는 문제 해결)
        const trackingHasGoodMatch = new Set();
        enriched.forEach(o => {
            (o.shipments || []).forEach(s => {
                if (s.tracking_no && !s.is_wrong_product && !s.is_bundle_companion) {
                    // 이 shipment 가 이 주문 기준으로 정상 매칭 (전부 matched)
                    trackingHasGoodMatch.add(s.tracking_no);
                }
                // 이 주문에서 bundle 처리된 운송장도 다른 곳에서는 매칭됐다는 신호 → 신뢰 가능
                if (s.tracking_no && s.is_bundle_companion) {
                    trackingHasGoodMatch.add(s.tracking_no);
                }
            });
        });

        let downgradedShipmentCount = 0;
        let recoveredOrderCount = 0;
        enriched.forEach(o => {
            let downgradedAny = false;
            (o.shipments || []).forEach(s => {
                if (s.is_wrong_product && s.tracking_no && trackingHasGoodMatch.has(s.tracking_no)) {
                    s.is_wrong_product = false;
                    s.is_bundle_companion = true;
                    s.auto_bundle_downgraded = true; // 디버깅용 플래그
                    downgradedAny = true;
                    downgradedShipmentCount++;
                }
            });
            if (!downgradedAny) return;

            // 모든 wrong이 해소되면 ship_status_overall 재분류
            const stillWrong = (o.shipments || []).some(s => s.is_wrong_product);
            if (!stillWrong && o.ship_status_overall === 'MISMATCHED') {
                const allShipped = (o.shipments || []).every(s => s.ship_status === 'SHIPPED');
                const hasMissing = (o.match_info?.missing_order_items || []).length > 0;
                if (allShipped && !hasMissing) {
                    o.ship_status_overall = (o.days_since_shipped !== null && o.days_since_shipped >= DELIVERY_ESTIMATE_DAYS)
                        ? 'DELIVERED' : 'SHIPPED';
                } else if (allShipped) {
                    o.ship_status_overall = 'SHIPPED';
                } else {
                    o.ship_status_overall = 'PARTIAL';
                }
                recoveredOrderCount++;
            }
        });
        if (downgradedShipmentCount > 0) {
            console.log(`[SHIPPING] 🔁 운송장 교차 검증: ${downgradedShipmentCount}건 묶음으로 강등, ${recoveredOrderCount}건 주문 상태 회복`);
        }

        // 4) status 필터 (신규 상태값)
        let filtered = enriched;
        if (status && status !== 'all') {
            const filterMap = {
                delivered:       'DELIVERED',
                shipped:         'SHIPPED',
                mismatched:      'MISMATCHED',       // 진짜 오배송 (운송장 있음)
                pickup_included: 'PICKUP_INCLUDED',  // 픽업상품예상포함 (운송장 없음)
                hold:            'HOLD',
                partial:         'PARTIAL',
                pending:         'PENDING',
                not_shipped:     'NOT_SHIPPED'
            };
            const target = filterMap[status];
            if (target) filtered = enriched.filter(e => e.ship_status_overall === target);
        }

        // 5) 요약 카운트
        const summary = enriched.reduce((acc, e) => {
            acc.total++;
            const k = e.ship_status_overall.toLowerCase();
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, { total: 0, delivered: 0, shipped: 0, mismatched: 0, pickup_included: 0, hold: 0, partial: 0, pending: 0, not_shipped: 0 });

        res.json({
            success: true,
            count: filtered.length,
            summary,
            data: filtered,
            delivery_estimate_days: DELIVERY_ESTIMATE_DAYS
        });
    } catch (e) {
        console.error("🔥 출하상황 조회 오류:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ==========================================
// 🕐 [7-3] 매니저 근무·시차 관리 (workHours)
// ==========================================
// - 카테고리: WORK(정상근무) / FLEX_USE(시차사용) / LEAVE(휴가) / HOLIDAY(휴일)
// - WORK: 출퇴근 시간으로 work_hours 계산 → 표준(8h) 초과 시 flex_delta 적립
// - FLEX_USE: flex_use_hours만큼 잔여에서 차감
// - 잔여 = SUM(flex_delta of WORK) - SUM(flex_use_hours of FLEX_USE)

async function ensureWorkHoursIndexes() {
    try {
        const col = db.collection(COLLECTION_WORK_HOURS);
        await col.createIndex({ manager_id: 1, work_date: 1 }, { unique: false });
        await col.createIndex({ manager_id: 1, year_month: 1 });
        console.log("✅ workHours 인덱스 확인 완료");
    } catch (e) {
        console.error("⚠️ workHours 인덱스 오류:", e.message);
    }
}

// 시:분 문자열 → 분 단위 환산
function hhmmToMinutes(s) {
    if (!s || typeof s !== 'string') return null;
    const [h, m] = s.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
}

// 근무 시간 계산: 출퇴근 + 점심시간 차감
function calcWorkHours(clockIn, clockOut, breakMinutes) {
    const inMin = hhmmToMinutes(clockIn);
    const outMin = hhmmToMinutes(clockOut);
    if (inMin === null || outMin === null) return null;
    let diff = outMin - inMin;
    if (diff < 0) diff += 24 * 60; // 자정 넘김 보정
    const breakMin = Math.max(0, Number(breakMinutes ?? WORK_BREAK_MINUTES));
    const netMin = Math.max(0, diff - breakMin);
    return Math.round((netMin / 60) * 100) / 100;
}

// 🆕 휴게시간 차감 없는 순수 체류 시간 (gross hours)
function calcGrossHours(clockIn, clockOut) {
    const inMin = hhmmToMinutes(clockIn);
    const outMin = hhmmToMinutes(clockOut);
    if (inMin === null || outMin === null) return 0;
    let diff = outMin - inMin;
    if (diff < 0) diff += 24 * 60;
    return Math.round((diff / 60) * 100) / 100;
}

// 🆕 휴게시간 자동 차감 기준 (근로기준법 — 실근무 시간 기준 역산)
//
//   법 기준: 실근무 4시간 이상 → 30분 휴게, 실근무 8시간 이상 → 60분 휴게
//   따라서 체류(gross) 시간으로 환산하면:
//   - 체류 ≥ 9h  → 60분 차감 (실근무 ≥ 8h)   예) 09:00~18:00 = 9h → 8h 실근무
//   - 체류 ≥ 4.5h → 30분 차감 (실근무 ≥ 4h)  예) 13:00~17:30 = 4.5h → 4h 실근무
//   - 체류 < 4.5h → 휴게 없음 (실근무 < 4h, 휴게 의무 없음)
//
//   ※ 체류 정확히 4h(휴게 미사용)는 차감 X — 그대로 4h 실근무로 인정
function getBreakMinutesForGrossHours(grossHours) {
    if (grossHours >= 9) return 60;
    if (grossHours >= 4.5) return 30;
    return 0;
}

// 🆕 (manager_id, work_date) 단위로 모든 entry 재계산
//   - 같은 날 여러 WORK 이 있으면 gross 합산 → 한국 노동법 휴게시간 적용 → 표준 대비 delta 계산
//   - 각 entry 에 비례 분배해서 저장
//   - FLEX_USE 는 별도로 -flex_use_hours 추가
//   - 일급제는 항상 flex_delta = 0
async function recomputeDailyFlex(manager_id, work_date) {
    if (!manager_id || !work_date) return;
    const dayEntries = await db.collection(COLLECTION_WORK_HOURS)
        .find({ manager_id: String(manager_id), work_date })
        .toArray();
    if (dayEntries.length === 0) return;

    const isDailyWage = dayEntries.some(e => String(e.manager_role || '').trim() === '일급제');
    const stdHours = getStandardHoursByDate(work_date);

    // WORK entries gross 합산
    let totalGross = 0;
    const grossById = new Map();
    dayEntries.forEach(e => {
        const cats = Array.isArray(e.categories) ? e.categories : (e.category ? [e.category] : []);
        if (cats.includes('WORK') && e.clock_in && e.clock_out) {
            const g = calcGrossHours(e.clock_in, e.clock_out);
            grossById.set(String(e._id), g);
            totalGross += g;
        }
    });

    const hasWork = totalGross > 0;
    const breakMin = hasWork ? getBreakMinutesForGrossHours(totalGross) : 0;
    const breakH = breakMin / 60;
    const totalNetWork = Math.max(0, totalGross - breakH);
    // 🆕 표준 미달 근무(예: 8h 기준에 5h만 일함)는 시차 잔여에서 차감하지 않음 (음수 시차 방지)
    //    초과 근무한 만큼만 시차로 적립, 미달은 0 처리. FLEX_USE 만 잔여 차감.
    const rawDelta = totalNetWork - stdHours;
    const dayWorkDelta = (hasWork && !isDailyWage) ? Math.max(0, rawDelta) : 0;

    // 각 entry 별 분배 + flex_use 차감
    const ops = [];
    for (const e of dayEntries) {
        const cats = Array.isArray(e.categories) ? e.categories : (e.category ? [e.category] : []);
        // FLEX_ADJUSTMENT 는 그대로 유지 (관리자 이월 입력, flex_delta 이미 저장됨)
        if (cats.includes('FLEX_ADJUSTMENT')) continue;

        let entryFlexDelta = 0;
        let entryWorkHours = 0;
        let entryBreak = 0;

        const myGross = grossById.get(String(e._id)) || 0;
        if (cats.includes('WORK') && myGross > 0) {
            const share = totalGross > 0 ? (myGross / totalGross) : 0;
            entryFlexDelta += dayWorkDelta * share;
            entryWorkHours = totalNetWork * share;
            entryBreak = Math.round(breakMin * share);
        }
        if (cats.includes('FLEX_USE') && !isDailyWage) {
            entryFlexDelta -= Number(e.flex_use_hours || 0);
        }

        ops.push(db.collection(COLLECTION_WORK_HOURS).updateOne(
            { _id: e._id },
            { $set: {
                flex_delta: Math.round(entryFlexDelta * 100) / 100,
                work_hours: Math.round(entryWorkHours * 100) / 100,
                standard_hours: stdHours,
                break_minutes: entryBreak,
                day_total_gross: Math.round(totalGross * 100) / 100,
                day_total_work: Math.round(totalNetWork * 100) / 100
            }}
        ));
    }
    await Promise.all(ops);
}

// 카테고리별 잔여 영향 계산
//   WORK(근무)      : work_hours - 표준 (+/-)
//   FLEX_USE(시차)  : -flex_use_hours
//   WEEKLY_OFF(주휴)/SUBSTITUTE_OFF(대휴)/ANNUAL_LEAVE(연차)/LEAVE/HOLIDAY : 0
const VALID_CATEGORIES = ['WORK','FLEX_USE','WEEKLY_OFF','SUBSTITUTE_OFF','ANNUAL_LEAVE','LEAVE','HOLIDAY','FLEX_ADJUSTMENT'];

function buildScheduleDoc(input) {
    const {
        manager_id, manager_name, store_name,
        work_date, categories, category,
        clock_in, clock_out, flex_use_hours,
        flex_use_position,   // 🆕 'FRONT'(늦은출근) | 'BACK'(일찍퇴근) — 기본 BACK
        annual_leave_type,   // 🆕 'FULL' | 'HALF_AM' | 'HALF_PM' (옛 'HALF' 호환)
        manager_role,        // 🆕 직급 ('일급제'이면 시차 발생/사용 미적용)
        note
    } = input;

    // 단일 또는 배열 모두 수용
    let cats = Array.isArray(categories) ? categories : (category ? [category] : []);
    cats = cats.filter(c => VALID_CATEGORIES.includes(c));
    if (cats.length === 0) return { error: 'category 필수' };

    if (!manager_id || !work_date) return { error: 'manager_id / work_date 필수' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date)) return { error: 'work_date 형식 오류 (YYYY-MM-DD)' };

    let work_hours = 0;
    if (cats.includes('WORK')) {
        const w = calcWorkHours(clock_in, clock_out, WORK_BREAK_MINUTES);
        if (w === null) return { error: '출퇴근 시간 형식 오류 (HH:MM)' };
        work_hours = w;
    }

    const flexUse = cats.includes('FLEX_USE') ? Number(flex_use_hours || 0) : 0;

    // 🆕 평일 8h / 주말 9h 기준 근무시간으로 flex_delta 계산
    const stdHours = getStandardHoursByDate(work_date);
    const isDailyWage = String(manager_role || '').trim() === '일급제';
    let flex_delta = 0;
    if (!isDailyWage) {
        // 🆕 일급제는 시차 발생/사용 모두 미반영 (delta = 0)
        if (cats.includes('WORK')) flex_delta += work_hours - stdHours;
        if (cats.includes('FLEX_USE')) flex_delta -= flexUse;
    }
    // (반차는 ANNUAL_LEAVE 서브타입으로 흡수 — 잔여 영향 없음)

    // 🆕 연차 서브타입 정규화 (옛 'HALF' → 'HALF_AM' 호환)
    let normAnnual = null;
    if (cats.includes('ANNUAL_LEAVE')) {
        if (annual_leave_type === 'HALF_AM' || annual_leave_type === 'HALF_PM') normAnnual = annual_leave_type;
        else if (annual_leave_type === 'HALF') normAnnual = 'HALF_AM';
        else normAnnual = 'FULL';
    }

    return {
        doc: {
            manager_id: String(manager_id),
            manager_name: String(manager_name || ''),
            store_name: String(store_name || ''),
            work_date,
            year_month: work_date.slice(0, 7),
            categories: cats,
            category: cats[0], // backward compat
            clock_in: cats.includes('WORK') ? (clock_in || null) : null,
            clock_out: cats.includes('WORK') ? (clock_out || null) : null,
            break_minutes: cats.includes('WORK') ? WORK_BREAK_MINUTES : 0,
            work_hours: Math.round(work_hours * 100) / 100,
            flex_use_hours: flexUse,
            // 🆕 시차 사용 방향 (FLEX_USE일 때만 의미, 기본 BACK)
            flex_use_position: cats.includes('FLEX_USE') ? (flex_use_position === 'FRONT' ? 'FRONT' : 'BACK') : null,
            flex_delta: Math.round(flex_delta * 100) / 100,
            standard_hours: stdHours, // 디버깅/확인용
            // 🆕 연차 서브타입
            annual_leave_type: normAnnual,
            // 🆕 직급 기록 (일급제 여부 추적용)
            manager_role: String(manager_role || ''),
            note: String(note || ''),
            updated_at: new Date()
        }
    };
}

// 사용 가능 시차 검증 — FLEX_USE 카테고리 포함 시 호출
async function validateFlexUse(managerId, workDate, requestedFlexHours) {
    const balanceInfo = await computeFlexBalance(managerId);
    // 같은 날짜에 기존 FLEX_USE 입력이 있으면 그 차감분은 복구 후 비교
    const existing = await db.collection(COLLECTION_WORK_HOURS).findOne({ manager_id: String(managerId), work_date: workDate });
    let restoredBalance = balanceInfo.balance_hours;
    if (existing && Array.isArray(existing.categories) && existing.categories.includes('FLEX_USE')) {
        restoredBalance += Number(existing.flex_use_hours || 0);
    } else if (existing && existing.category === 'FLEX_USE') {
        restoredBalance += Number(existing.flex_use_hours || 0);
    }
    if (requestedFlexHours > restoredBalance + 0.001) {
        return { ok: false, available: restoredBalance, requested: requestedFlexHours };
    }
    return { ok: true, available: restoredBalance };
}

// 🆕 _id 가 있으면 그 row 수정, 없으면 항상 insert (같은 날짜 여러 입력 허용)
app.post('/api/work-hours', async (req, res) => {
    try {
        const { _id, ...input } = req.body;
        const result = buildScheduleDoc(input);
        if (result.error) return res.status(400).json({ success: false, message: result.error });

        // 🆕 FLEX_USE 한도 검증 (수정 모드일 땐 자기 기존 차감분은 복구해서 비교)
        if (result.doc.categories.includes('FLEX_USE')) {
            const v = await validateFlexUseById(result.doc.manager_id, _id, result.doc.flex_use_hours);
            if (!v.ok) {
                return res.status(400).json({
                    success: false,
                    message: `사용 가능 시차(${v.available.toFixed(1)}h)를 초과합니다. 요청: ${v.requested}h`
                });
            }
        }

        let upserted = false, modifiedCount = 0;
        let prevDate = null;
        if (_id && ObjectId.isValid(_id)) {
            // 수정 전 날짜 기록 (날짜가 바뀐 경우 옛 날짜도 재계산해야 함)
            const old = await db.collection(COLLECTION_WORK_HOURS).findOne({ _id: new ObjectId(_id) });
            prevDate = old?.work_date || null;
            const r = await db.collection(COLLECTION_WORK_HOURS).updateOne(
                { _id: new ObjectId(_id) },
                { $set: result.doc }
            );
            modifiedCount = r.modifiedCount;
        } else {
            const r = await db.collection(COLLECTION_WORK_HOURS).insertOne({
                ...result.doc,
                created_at: new Date()
            });
            upserted = !!r.insertedId;
        }
        // 🆕 하루 단위 재계산 (같은 날 여러 entry 합산 + 한국 노동법 휴게시간 적용)
        await recomputeDailyFlex(result.doc.manager_id, result.doc.work_date);
        if (prevDate && prevDate !== result.doc.work_date) {
            await recomputeDailyFlex(result.doc.manager_id, prevDate);
        }
        const balance = await computeFlexBalance(result.doc.manager_id);
        res.json({ success: true, upserted, modifiedCount, balance });
    } catch (e) {
        console.error('🔥 work-hours POST 오류:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// 🆕 _id 기반 시차 한도 검증 (수정 모드: 자기 자신은 잔액에서 복구)
async function validateFlexUseById(managerId, editingId, requestedFlexHours) {
    const balanceInfo = await computeFlexBalance(managerId);
    let restoredBalance = balanceInfo.balance_hours;
    if (editingId && ObjectId.isValid(editingId)) {
        const existing = await db.collection(COLLECTION_WORK_HOURS).findOne({ _id: new ObjectId(editingId) });
        if (existing && Array.isArray(existing.categories) && existing.categories.includes('FLEX_USE')) {
            restoredBalance += Number(existing.flex_use_hours || 0);
        }
    }
    if (requestedFlexHours > restoredBalance + 0.001) {
        return { ok: false, available: restoredBalance, requested: requestedFlexHours };
    }
    return { ok: true, available: restoredBalance };
}

// 🆕 벌크 입력: dates[] × managers[] 매트릭스로 한꺼번에 적용
app.post('/api/work-hours/bulk', async (req, res) => {
    try {
        const {
            dates,            // ['YYYY-MM-DD', ...]
            managers,         // [{id, name, store_name}, ...]
            categories,       // ['WORK', ...]
            clock_in, clock_out, flex_use_hours,
            flex_use_position,   // 🆕 'FRONT' | 'BACK'
            annual_leave_type,   // 🆕 'FULL' | 'HALF_AM' | 'HALF_PM'
            note,
            overwrite = true  // 기존 입력 덮어쓰기 여부 (false면 skip)
        } = req.body;

        if (!Array.isArray(dates) || dates.length === 0) return res.status(400).json({ success: false, message: 'dates 필수' });
        if (!Array.isArray(managers) || managers.length === 0) return res.status(400).json({ success: false, message: 'managers 필수' });
        if (!Array.isArray(categories) || categories.length === 0) return res.status(400).json({ success: false, message: 'categories 필수' });

        let inserted = 0, modified = 0, skipped = 0, errors = [];
        const now = new Date();

        // 🆕 FLEX_USE 한도 사전 검증 (매니저별)
        if (categories.includes('FLEX_USE')) {
            const requestedTotal = Number(flex_use_hours || 0) * dates.length;
            const blocked = [];
            for (const m of managers) {
                const bal = await computeFlexBalance(m.id);
                if (bal.balance_hours < requestedTotal - 0.001) {
                    blocked.push({ name: m.name, avail: bal.balance_hours, need: requestedTotal });
                }
            }
            if (blocked.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: '사용 가능 시차를 초과한 직원이 있습니다.',
                    blocked
                });
            }
        }

        for (const d of dates) {
            for (const m of managers) {
                const built = buildScheduleDoc({
                    manager_id: m.id, manager_name: m.name, store_name: m.store_name,
                    manager_role: m.role || '',
                    work_date: d, categories, clock_in, clock_out, flex_use_hours,
                    flex_use_position, annual_leave_type, note
                });
                if (built.error) { errors.push({ date: d, manager: m.name, msg: built.error }); continue; }

                const filter = { manager_id: built.doc.manager_id, work_date: d };
                if (!overwrite) {
                    const exists = await db.collection(COLLECTION_WORK_HOURS).findOne(filter);
                    if (exists) { skipped++; continue; }
                }
                const r = await db.collection(COLLECTION_WORK_HOURS).updateOne(
                    filter,
                    { $set: built.doc, $setOnInsert: { created_at: now } },
                    { upsert: true }
                );
                if (r.upsertedId) inserted++; else modified++;
            }
        }

        // 🆕 각 (매니저 × 날짜) 페어에 대해 일별 재계산
        const recomputeOps = [];
        for (const d of dates) {
            for (const m of managers) {
                recomputeOps.push(recomputeDailyFlex(m.id, d));
            }
        }
        await Promise.all(recomputeOps);

        res.json({
            success: true,
            totalRequested: dates.length * managers.length,
            inserted, modified, skipped,
            errors: errors.slice(0, 20) // 최대 20개만 노출
        });
    } catch (e) {
        console.error('🔥 work-hours bulk 오류:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// 월별 조회 (캘린더용)
app.get('/api/work-hours', async (req, res) => {
    try {
        const { manager_id, month, store_name } = req.query;
        const q = {};
        if (manager_id) q.manager_id = String(manager_id);
        if (month && /^\d{4}-\d{2}$/.test(month)) q.year_month = month;
        if (store_name) q.store_name = String(store_name);

        const data = await db.collection(COLLECTION_WORK_HOURS).find(q).sort({ work_date: 1 }).toArray();
        res.json({ success: true, count: data.length, data });
    } catch (e) {
        console.error('🔥 work-hours GET 오류:', e);
        res.status(500).json({ success: false });
    }
});

// 단일 삭제 (해당 매니저+날짜 입력 취소)
app.delete('/api/work-hours/:id', async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
        const before = await db.collection(COLLECTION_WORK_HOURS).findOne({ _id: new ObjectId(req.params.id) });
        await db.collection(COLLECTION_WORK_HOURS).deleteOne({ _id: new ObjectId(req.params.id) });
        // 🆕 같은 날짜 다른 entry들 재계산 (남은 entry들의 비례 분배 갱신)
        if (before?.manager_id && before?.work_date) {
            await recomputeDailyFlex(before.manager_id, before.work_date);
        }
        const balance = before ? await computeFlexBalance(before.manager_id) : null;
        res.json({ success: true, balance });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 매니저별 시차 잔여 계산 (모든 기간 합산)
async function computeFlexBalance(managerId) {
    try {
        const agg = await db.collection(COLLECTION_WORK_HOURS).aggregate([
            { $match: { manager_id: String(managerId) } },
            { $group: {
                _id: null,
                total_work_hours: { $sum: '$work_hours' },
                total_flex_earned: { $sum: { $cond: [{ $gt: ['$flex_delta', 0] }, '$flex_delta', 0] } },
                total_flex_used: { $sum: { $cond: [{ $lt: ['$flex_delta', 0] }, { $abs: '$flex_delta' }, 0] } },
                net_flex_delta: { $sum: '$flex_delta' }
            }}
        ]).toArray();
        const r = agg[0] || {};
        return {
            balance_hours: Math.round((r.net_flex_delta || 0) * 100) / 100,   // 잔여 (음수면 빚진 시간)
            total_work_hours: Math.round((r.total_work_hours || 0) * 100) / 100,
            total_flex_earned: Math.round((r.total_flex_earned || 0) * 100) / 100,
            total_flex_used: Math.round((r.total_flex_used || 0) * 100) / 100
        };
    } catch (e) {
        return { balance_hours: 0, total_work_hours: 0, total_flex_earned: 0, total_flex_used: 0 };
    }
}

app.get('/api/work-hours/balance', async (req, res) => {
    try {
        const { manager_id } = req.query;
        if (!manager_id) return res.status(400).json({ success: false, message: 'manager_id 필수' });
        const balance = await computeFlexBalance(manager_id);
        res.json({ success: true, balance });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 🆕 매니저별 이월 시차 조정 내역 조회 (최신순)
app.get('/api/work-hours/flex-adjustments', async (req, res) => {
    try {
        const { manager_id } = req.query;
        if (!manager_id) return res.status(400).json({ success: false, message: 'manager_id 필수' });
        const rows = await db.collection(COLLECTION_WORK_HOURS)
            .find({ manager_id: String(manager_id), categories: 'FLEX_ADJUSTMENT' })
            .sort({ created_at: -1 })
            .toArray();
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 🆕 이월 시차 항목 삭제 (잔여 자동 환원)
app.delete('/api/work-hours/flex-adjustment/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: '잘못된 id' });
        const doc = await db.collection(COLLECTION_WORK_HOURS).findOne({ _id: new ObjectId(id) });
        if (!doc) return res.status(404).json({ success: false, message: '존재하지 않는 항목' });
        await db.collection(COLLECTION_WORK_HOURS).deleteOne({ _id: new ObjectId(id) });
        const balance = doc.manager_id ? await computeFlexBalance(doc.manager_id) : null;
        res.json({ success: true, balance });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 🆕 관리자 전용: 시차 잔여 수동 조정 (이월/오프셋)
// 별도 work_date 없이 카테고리 FLEX_ADJUSTMENT 로 누적 → flex_delta 합산에 자연 포함
app.post('/api/work-hours/flex-adjustment', async (req, res) => {
    try {
        const { manager_id, manager_name, store_name, amount, note } = req.body;
        if (!manager_id) return res.status(400).json({ success: false, message: 'manager_id 필수' });
        const amt = Number(amount);
        if (!amt || isNaN(amt)) return res.status(400).json({ success: false, message: 'amount(0이 아닌 숫자) 필수' });

        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

        const doc = {
            manager_id: String(manager_id),
            manager_name: String(manager_name || ''),
            store_name: String(store_name || ''),
            work_date: todayStr,
            year_month: todayStr.slice(0, 7),
            categories: ['FLEX_ADJUSTMENT'],
            category: 'FLEX_ADJUSTMENT',
            clock_in: null,
            clock_out: null,
            break_minutes: 0,
            work_hours: 0,
            flex_use_hours: 0,
            flex_use_position: null,
            flex_delta: Math.round(amt * 100) / 100,
            standard_hours: 0,
            annual_leave_type: null,
            note: String(note || ''),
            is_manual_adjustment: true,   // 표시용 플래그
            created_at: now,
            updated_at: now
        };

        // 같은 매니저+이번달의 기존 조정 row가 있어도 누적 가능하도록 별도 _id로 insert
        await db.collection(COLLECTION_WORK_HOURS).insertOne(doc);
        const balance = await computeFlexBalance(doc.manager_id);
        res.json({ success: true, balance });
    } catch (e) {
        console.error('🔥 flex-adjustment 오류:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// 월별 요약 (이번 달 근무·시차 통계)
app.get('/api/work-hours/monthly-summary', async (req, res) => {
    try {
        const { manager_id, month } = req.query;
        if (!manager_id || !month) return res.status(400).json({ success: false, message: 'manager_id, month 필수' });
        const agg = await db.collection(COLLECTION_WORK_HOURS).aggregate([
            { $match: { manager_id: String(manager_id), year_month: month } },
            { $group: {
                _id: null,
                workDays: { $sum: { $cond: [{ $eq: ['$category', 'WORK'] }, 1, 0] } },
                leaveDays: { $sum: { $cond: [{ $eq: ['$category', 'LEAVE'] }, 1, 0] } },
                flexUseDays: { $sum: { $cond: [{ $eq: ['$category', 'FLEX_USE'] }, 1, 0] } },
                holidayDays: { $sum: { $cond: [{ $eq: ['$category', 'HOLIDAY'] }, 1, 0] } },
                total_work_hours: { $sum: '$work_hours' },
                total_flex_used: { $sum: { $cond: [{ $eq: ['$category', 'FLEX_USE'] }, '$flex_use_hours', 0] } },
                month_flex_delta: { $sum: '$flex_delta' }
            }}
        ]).toArray();
        const balance = await computeFlexBalance(manager_id);
        res.json({
            success: true,
            month_summary: agg[0] || { workDays:0, leaveDays:0, flexUseDays:0, holidayDays:0, total_work_hours:0, total_flex_used:0, month_flex_delta:0 },
            balance
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// [8] 비즈엠 알림톡
// ==========================================
app.post('/api/send-alimtalk', async (req, res) => {
    try {
        const { orderId, receiver } = req.body;
        
        if (!ObjectId.isValid(orderId)) {
            return res.status(400).json({ success: false, message: '유효하지 않은 주문 ID입니다.' });
        }
        
        const order = await db.collection(COLLECTION_ORDERS).findOne({ _id: new ObjectId(orderId) });
        if (!order) {
            return res.status(404).json({ success: false, message: '주문 내역을 찾을 수 없습니다.' });
        }

        const customerName = order.customer_name || '고객';
        const storeName = order.store_name || '미지정';
        const contactPhone = order.customer_phone || receiver; 
        
        const address = order.customer_address || '매장 직접 수령 (또는 미입력)';
        
        let productListText = '';
        if (order.items && order.items.length > 0) {
            productListText = order.items.map(item => {
                const name = item.product_name;
                const option = item.option_name && item.option_name !== '.' ? ` [${item.option_name}]` : '';
                const qty = Number(item.quantity) || 1;
                return `- ${name}${option} (${qty}개)`;
            }).join('\n');
        } else {
            const name = order.product_name || '요기보 상품';
            const option = order.option_name && order.option_name !== '.' ? ` [${order.option_name}]` : '';
            const qty = Number(order.quantity) || 1;
            productListText = `- ${name}${option} (${qty}개)`;
        }

        const formatPrice = (num) => Number(num || 0).toLocaleString('ko-KR');
        const totalAmount = formatPrice(order.total_amount || 0);

        const msgText = `[Yogibo] 주문이 완료되었습니다.

안녕하세요, ${customerName}님!
요기보 ${storeName} 매장을 이용해 주셔서 감사합니다.
고객님의 주문 내역을 안내해 드립니다.

■ 배송 정보
- 고객명: ${customerName}
- 연락처: ${contactPhone}
- 주소: ${address}

■ 주문 상품 정보
${productListText}

■ 결제 정보
- 총 결제금액: ${totalAmount}원`;

        const payload = [{
            "message_type": "at",
            "phn": receiver.replace(/-/g, ''),
            "profile": BIZM_PROFILE_KEY,
            "tmplId": "OFF_RECEIPTS", 
            "msg": msgText,
            "button1": { 
                "name": "FAQ 바로가기",
                "type": "WL", 
                "url_mobile": "https://yogibo.kr/off/faq/index.html",
                "url_pc": "https://yogibo.kr/off/faq/index.html" 
            },
            "smsKind": "L",
            "smsMsg": msgText,
            "smsSender": BIZM_SENDER_PHONE
        }];

        const response = await axios.post('https://alimtalk-api.bizmsg.kr/v2/sender/send', payload, {
            headers: { 'userid': BIZM_USER_ID, 'Content-Type': 'application/json' }
        });

        res.json({ success: true, result: response.data });
    } catch (error) { 
        console.error("🔥 비즈엠 알림톡 발송 에러:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: '알림톡 발송 중 서버 에러가 발생했습니다.' }); 
    }
});