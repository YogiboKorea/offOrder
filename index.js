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


// 변경 (origin === 'null' 추가)
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || origin === 'null' || whitelist.indexOf(origin) !== -1 || origin.includes('cafe24.com')) {
            callback(null, true);
        } else {
            console.log("🚫 CORS 차단됨:", origin);
            callback(new Error('CORS 정책에 의해 차단되었습니다.'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'userid'],
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
const COLLECTION_CREDENTIALS = "storeCredentials";
const COLLECTION_AUTH = "authSettings"; 

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

        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error("🔥 Server Error:", err);
    }
}
startServer();

async function initializeGlobalPin() {
    try {
        const count = await db.collection(COLLECTION_AUTH).countDocuments({ type: 'global_pin' });
        if (count === 0) {
            await db.collection(COLLECTION_AUTH).insertOne({ type: 'global_pin', pinCode: '111', created_at: new Date() });
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
// [4] 매장 접속 권한 검증 및 미들웨어
// ==========================================

app.post('/api/verify-pin', async (req, res) => {
    try {
        const { pin } = req.body;
        const setting = await db.collection(COLLECTION_AUTH).findOne({ type: 'global_pin' });
        
        if (setting && String(setting.pinCode) === String(pin)) {
            res.json({ success: true, token: pin }); 
        } else {
            res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// 🚨 여기가 401 에러를 발생시키는 방어막(미들웨어) 입니다.
const authMiddleware = async (req, res, next) => {
    
    // ★★★ 테스트를 위해 보안 검증을 무조건 통과시키도록 주석 처리 및 수정했습니다 ★★★
    console.log("⚠️ 현재 보안 인증(PIN)이 임시로 해제되어 무조건 통과됩니다.");
    return next(); // 이 한 줄로 인해 자물쇠가 풀립니다.

    /* 나중에 PIN 번호를 다시 활성화 하려면 위 두 줄을 지우고 아래 주석을 푸세요.
    const authHeader = req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: '인증 정보가 없습니다. 401 에러 발생!' });
    }

    const token = authHeader.split(' ')[1]; 
    try {
        const setting = await db.collection(COLLECTION_AUTH).findOne({ type: 'global_pin' });
        if (!setting || String(setting.pinCode) !== String(token)) {
            return res.status(403).json({ success: false, message: '비밀번호가 다릅니다. 403 에러 발생!' });
        }
        next(); 
    } catch(e) {
        res.status(500).json({ success: false });
    }
    */
};

app.post('/api/auth/store/password', async (req, res) => {
    try {
        const { storeName, password } = req.body;
        if (!storeName || !password) return res.status(400).json({ success: false, message: '값 누락' });
        await db.collection(COLLECTION_CREDENTIALS).updateOne(
            { storeName: storeName }, { $set: { password: password, updatedAt: new Date() } }, { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/auth/store/login', async (req, res) => {
    try {
        const { storeName, password } = req.body;
        const cred = await db.collection(COLLECTION_CREDENTIALS).findOne({ storeName: storeName });
        if (cred && cred.password === password) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '비밀번호 불일치' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/auth/store/credentials', async (req, res) => {
    try {
        const credentials = await db.collection(COLLECTION_CREDENTIALS).find({}).toArray();
        res.json({ success: true, data: credentials });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ==========================================
// [5] Cafe24 API (상품 & 옵션 조회)
// ==========================================
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
        const cleanData = products.map(item => {
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
                product_no: item.product_no, product_name: item.product_name,
                price: Math.floor(Number(item.price)), options: myOptions,
                detail_image: img
            };
        });
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
        res.json({ success: true, product_no: product.product_no, product_name: product.product_name, options: myOptions });
    } catch (error) { res.status(500).json({ success: false, message: "Cafe24 API Error" }); }
});


// ==========================================
// [5-2] Cafe24 쿠폰 조회 - ★ 상세 조회 포함 버전
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

        // 1단계: 쿠폰 목록 조회 (다운로드 쿠폰만)
        const listRes = await fetchFromCafe24(
            `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`,
            { shop_no: 1, limit: 100, issue_type: 'D' }
        );
        const coupons = listRes.data.coupons || [];
        console.log(`🎫 쿠폰 전체 수신: ${coupons.length}개`);

        const now = new Date();
        const activeCoupons = coupons.filter(c => {
            if (c.deleted === 'T') return false;
            if (c.is_stopped_issued_coupon === 'T') return false;
            if (c.issue_type !== 'D') return false;
            if (c.issue_start_date) {
                if (new Date(c.issue_start_date) > now) return false;
            }
            if (c.issue_end_date) {
                if (new Date(c.issue_end_date) < now) return false;
            }
            if (c.available_period_type === 'F') {
                if (c.available_start_datetime && new Date(c.available_start_datetime) > now) return false;
                if (c.available_end_datetime && new Date(c.available_end_datetime) < now) return false;
            }
            return true;
        });

        console.log(`✅ 유효한 다운로드 쿠폰: ${activeCoupons.length}개`);

        // 2단계: 각 쿠폰 상세 조회 (적용 상품 목록 가져오기)
        const detailResults = await Promise.allSettled(
            activeCoupons.map(c =>
                fetchFromCafe24(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons/${c.coupon_no}`,
                    { shop_no: 1 }
                )
            )
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
                    availableProducts = raw.map(p => {
                        if (typeof p === 'object' && p !== null && p.product_no) return Number(p.product_no);
                        return Number(p);
                    }).filter(n => !isNaN(n));
                } else if (typeof raw === 'number') {
                    availableProducts = [raw];
                } else if (typeof raw === 'string' && raw) {
                    availableProducts = raw.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
                }
            }

            console.log(`  - [${c.coupon_no}] ${c.coupon_name} | 타입:${c.benefit_type} | 상품적용:${availableProductType} | 상품수:${availableProducts.length}`);

            return {
                coupon_no: c.coupon_no,
                coupon_name: c.coupon_name,
                benefit_type: c.benefit_type,
                benefit_percentage: c.benefit_percentage ? parseFloat(c.benefit_percentage) : null,
                benefit_price: c.benefit_price ? Math.floor(parseFloat(c.benefit_price)) : null,
                benefit_percentage_max_price: c.benefit_percentage_max_price
                    ? Math.floor(parseFloat(c.benefit_percentage_max_price)) : null,
                available_date: c.available_date || '',
                benefit_text: c.benefit_text || '',
                available_product_type: availableProductType,
                available_product: availableProducts,
                issue_type: c.issue_type || '',
            };
        });

        // 상품 적용 쿠폰만 로그 강조
        const productSpecific = enriched.filter(c => c.available_product_type === 'I' && c.available_product.length > 0);
        console.log(`🎯 상품 지정 쿠폰: ${productSpecific.length}개`);
        productSpecific.forEach(c => {
            console.log(`  🏷️ ${c.coupon_name}: 상품 ${c.available_product.length}개 [${c.available_product.slice(0, 5).join(', ')}${c.available_product.length > 5 ? '...' : ''}]`);
        });

        res.json({ success: true, count: enriched.length, data: enriched });
    } catch (error) {
        console.error('쿠폰 조회 에러:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Cafe24 Coupon API Error', detail: error.response?.data });
    }
});
// ==========================================
// [5-3] 쿠폰-상품 매핑 API (server.js에 추가)
// ==========================================
// 아래 코드를 server.js의 [5-2] 쿠폰 조회 섹션 아래에 추가하세요
// ==========================================

const COLLECTION_COUPON_MAP = "couponProductMap";
app.get('/api/cafe24/coupons/:couponNo', async (req, res) => {
    try {
        const { couponNo } = req.params;

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

        // 1) 쿠폰 조회
        const couponRes = await fetchFromCafe24(
            `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`,
            { shop_no: 1, coupon_no: couponNo }
        );
        const coupon = (couponRes.data.coupons || [])[0];
        if (!coupon) return res.status(404).json({ success: false, message: '쿠폰 없음' });

        // 2) ★ available_product_list에서 상품번호 추출
        const productNos = coupon.available_product_list || [];
        console.log(`🎫 [${coupon.coupon_no}] ${coupon.coupon_name} / 타입:${coupon.available_product} / 상품:${productNos.length}개`);

        // 3) 상품번호로 Cafe24 상품 상세 조회 (한번에 최대 100개)
        let productDetails = [];
        if (productNos.length > 0) {
            try {
                const productRes = await fetchFromCafe24(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                    {
                        shop_no: 1,
                        product_no: productNos.join(','),
                        fields: 'product_no,product_name,price,detail_image,list_image,small_image',
                        limit: 1000
                    }
                );
                productDetails = (productRes.data.products || []).map(p => ({
                    product_no: p.product_no,
                    product_name: p.product_name,
                    price: Math.floor(Number(p.price)),
                    image: p.detail_image || p.list_image || p.small_image || ''
                }));
                console.log(`✅ 상품 상세 조회 완료: ${productDetails.length}개`);
            } catch (e) {
                console.error('상품 상세 조회 실패:', e.message);
                // 실패해도 번호만이라도 반환
                productDetails = productNos.map(no => ({
                    product_no: no,
                    product_name: `상품 #${no}`,
                    price: 0,
                    image: ''
                }));
            }
        }

        const result = {
            coupon_no: coupon.coupon_no,
            coupon_name: coupon.coupon_name,
            benefit_type: coupon.benefit_type,
            benefit_percentage: coupon.benefit_percentage ? parseFloat(coupon.benefit_percentage) : null,
            benefit_price: coupon.benefit_price ? Math.floor(parseFloat(coupon.benefit_price)) : null,
            available_product_type: coupon.available_product || 'A',
            available_product_list: productNos,
            products: productDetails,
        };

        console.log(`✅ 응답: 할인 ${result.benefit_percentage || result.benefit_price} / 상품 ${productDetails.length}개`);
        res.json({ success: true, data: result });

    } catch (error) {
        console.error('쿠폰 조회 에러:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Cafe24 Coupon API Error' });
    }
});
app.post('/api/coupon-map', async (req, res) => {
    try {
        const { coupon_no, coupon_name, benefit_type, benefit_percentage, benefit_price, start_date, end_date, products } = req.body;
        if (!coupon_no) return res.status(400).json({ success: false, message: 'coupon_no 필수' });

        await db.collection(COLLECTION_COUPON_MAP).updateOne(
            { coupon_no: String(coupon_no) },
            {
                $set: {
                    coupon_no: String(coupon_no),
                    coupon_name: coupon_name || '',
                    benefit_type: benefit_type || 'B',
                    benefit_percentage: benefit_percentage || null,
                    benefit_price: benefit_price || null,
                    start_date: start_date || '',
                    end_date: end_date || '',
                    products: products || [],
                    updated_at: new Date()
                }
            },
            { upsert: true }
        );
        console.log(`✅ 쿠폰 매핑 저장: [${coupon_no}] ${coupon_name} / 기간:${start_date}~${end_date} / 상품 ${(products || []).length}개`);
        res.json({ success: true });
    } catch (e) {
        console.error('매핑 저장 에러:', e);
        res.status(500).json({ success: false });
    }
});
app.get('/api/coupon-map', async (req, res) => {
    try {
        const mappings = await db.collection(COLLECTION_COUPON_MAP).find({}).toArray();

        // ★ 오늘 날짜 기준으로 유효한 쿠폰만 필터
        const today = new Date().toISOString().slice(0, 10);
        const active = mappings.filter(m => {
            if (!m.end_date) return true;  // 기간 미설정이면 유효
            return m.end_date >= today;
        });

        console.log(`📦 쿠폰 매핑 조회: 전체 ${mappings.length}개 / 유효 ${active.length}개`);
        res.json({ success: true, data: active });
    } catch (e) {
        console.error('매핑 조회 에러:', e);
        res.status(500).json({ success: false });
    }
});

// ★ 특정 쿠폰 매핑 조회
app.get('/api/coupon-map/:couponNo', async (req, res) => {
    try {
        const mapping = await db.collection(COLLECTION_COUPON_MAP).findOne({ coupon_no: String(req.params.couponNo) });
        res.json({ success: true, data: mapping || { products: [] } });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ★ 쿠폰 매핑 삭제
app.delete('/api/coupon-map/:couponNo', async (req, res) => {
    try {
        await db.collection(COLLECTION_COUPON_MAP).deleteOne({ coupon_no: String(req.params.couponNo) });
        console.log(`🗑️ 쿠폰 매핑 삭제: ${req.params.couponNo}`);
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
            query.is_synced = true;
        } else {
            query.is_deleted = { $ne: true };
            query.is_synced = { $ne: true }; 
        }

        if (store_name && store_name !== '전체' && store_name !== 'null') query.store_name = store_name;
        if (startDate && endDate) {
            query.created_at = { $gte: new Date(startDate + "T00:00:00.000Z"), $lte: new Date(endDate + "T23:59:59.999Z") };
        }
        if (keyword) {
            query.$or = [
                { customer_name: { $regex: keyword, $options: 'i' } },
                { customer_phone: { $regex: keyword, $options: 'i' } },
                { product_name: { $regex: keyword, $options: 'i' } }
            ];
        }
        const orders = await db.collection(COLLECTION_ORDERS).find(query).sort({ created_at: -1 }).toArray();
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 방패(authMiddleware)가 장착되어 있지만 위에서 무조건 패스하도록 설정함
app.post('/api/ordersOffData', authMiddleware, async (req, res) => {
    try {
        const d = req.body;
        const items = d.items || [{ product_name: d.product_name, option_name: d.option_name, price: 0, quantity: 1 }];
        const newOrder = {
            ...d, items,
            total_amount: Number(d.total_amount) || 0,
            shipping_cost: Number(d.shipping_cost) || 0,
            is_synced: false, 
            is_deleted: false,
            created_at: new Date(), 
            synced_at: null,
            ecount_success: null
        };
        delete newOrder._id;
        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, message: "Order Saved", orderId: result.insertedId });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

app.put('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });
        
        const f = { ...req.body, updated_at: new Date() };
        delete f._id;
        if (f.shipping_cost !== undefined) f.shipping_cost = Number(f.shipping_cost);
        if (f.total_amount !== undefined) f.total_amount = Number(f.total_amount);

        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(id) }, { $set: f });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { type } = req.query;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        if (type === 'hard') {
            await db.collection(COLLECTION_ORDERS).deleteOne({ _id: new ObjectId(id) });
        } else {
            await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(id) }, { $set: { is_deleted: true, deleted_at: new Date() } });
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/ordersOffData/restore/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        await db.collection(COLLECTION_ORDERS).updateOne(
            { _id: new ObjectId(id) },
            { $set: { is_deleted: false, deleted_at: null, is_synced: false, synced_at: null, ecount_status: null, ecount_message: null } }
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const { results } = req.body; 
        if (!results || !Array.isArray(results)) return res.status(400).json({ success: false });

        const bulkOps = results.map(item => ({
            updateOne: {
                filter: { _id: new ObjectId(item.id) },
                update: { $set: { 
                    is_synced: true, synced_at: new Date(), 
                    ecount_success: item.status === 'SUCCESS', 
                    ecount_message: item.message || '' 
                }}
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
                { $set: { is_synced: true, synced_at: new Date(), ecount_success: item.status === 'SUCCESS', ecount_message: item.message || '' } }
            );
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// [7] 정적 데이터 및 CS 메모
// ==========================================
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
        const memos = await db.collection(COLLECTION_CS_MEMOS).find({ order_id: req.params.orderId }).sort({ created_at: -1 }).toArray();
        res.json({ success: true, data: memos });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.post('/api/cs-memos', async (req, res) => {
    try {
        const { orderId, content, writer } = req.body;
        await db.collection(COLLECTION_CS_MEMOS).insertOne({ order_id: orderId, content, writer: writer || '관리자', created_at: new Date() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.delete('/api/cs-memos/:id', async (req, res) => {
    try {
        await db.collection(COLLECTION_CS_MEMOS).deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});


// ==========================================
// [8] 비즈앰 알림톡
// ==========================================
app.post('/api/send-alimtalk', async (req, res) => {
    try {
        const { orderId, receiver } = req.body;
        const receiptUrl = `${MY_DOMAIN}/receipt/${orderId}`;
        const payload = [{
            "message_type": "at",
            "phn": receiver.replace(/-/g, ''),
            "profile": BIZM_PROFILE_KEY,
            "tmplId": "승인된_템플릿_코드", 
            "msg": `[Yogibo] 주문 안내...`,        
            "button1": { "name": "전자 영수증 보기", "type": "WL", "url_mobile": receiptUrl, "url_pc": receiptUrl },
            "smsKind": "L",
            "smsMsg": `[Yogibo] 주문 안내...\n\n영수증: ${receiptUrl}`,
            "smsSender": BIZM_SENDER_PHONE
        }];

        const response = await axios.post('https://alimtalk-api.bizmsg.kr/v2/sender/send', payload, {
            headers: { 'userid': BIZM_USER_ID, 'Content-Type': 'application/json' }
        });
        res.json({ success: true, result: response.data });
    } catch (error) { res.status(500).json({ success: false }); }
});