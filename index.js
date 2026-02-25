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
const COLLECTION_PIN_DATA = "OFFPINDATA"; 
const COLLECTION_AUTH = "authSettings";   
const COLLECTION_COUPON_MAP = "couponProductMap"; 

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

        if (view === 'trash') query.is_deleted = true;
        else if (view === 'completed') { query.is_deleted = { $ne: true }; query.is_synced = true; } 
        else { query.is_deleted = { $ne: true }; query.is_synced = { $ne: true }; }

        if (store_name && store_name !== '전체' && store_name !== 'null') query.store_name = store_name;
        if (startDate && endDate) query.created_at = { $gte: new Date(startDate + "T00:00:00.000Z"), $lte: new Date(endDate + "T23:59:59.999Z") };
        if (keyword) query.$or = [ { customer_name: { $regex: keyword, $options: 'i' } }, { customer_phone: { $regex: keyword, $options: 'i' } }, { product_name: { $regex: keyword, $options: 'i' } } ];
        
        const orders = await db.collection(COLLECTION_ORDERS).find(query).sort({ created_at: -1 }).toArray();
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/ordersOffData', authMiddleware, async (req, res) => {
    try {
        const d = req.body;
        const items = d.items || [{ product_name: d.product_name, option_name: d.option_name, price: 0, quantity: 1 }];
        const newOrder = {
            ...d, items,
            total_amount: Number(d.total_amount) || 0,
            shipping_cost: Number(d.shipping_cost) || 0,
            is_synced: false, is_deleted: false,
            created_at: new Date(), synced_at: null, ecount_success: null
        };
        delete newOrder._id;
        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, orderId: result.insertedId });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
        const f = { ...req.body, updated_at: new Date() };
        delete f._id;
        if (f.shipping_cost !== undefined) f.shipping_cost = Number(f.shipping_cost);
        if (f.total_amount !== undefined) f.total_amount = Number(f.total_amount);
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
        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(req.params.id) }, { $set: { is_deleted: false, deleted_at: null, is_synced: false, synced_at: null, ecount_status: null, ecount_message: null } });
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
                update: { $set: { is_synced: true, synced_at: new Date(), ecount_success: item.status === 'SUCCESS', ecount_message: item.message || '' } }
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
// [7] 정적 데이터 (매장, 창고, 담당자 등)
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
// [8] 비즈엠 알림톡 (주소 & 옵션명 포함 최종본)
// ==========================================
app.post('/api/send-alimtalk', async (req, res) => {
    try {
        const { orderId, receiver } = req.body;
        
        // 1. DB에서 주문 데이터 조회
        if (!ObjectId.isValid(orderId)) {
            return res.status(400).json({ success: false, message: '유효하지 않은 주문 ID입니다.' });
        }
        
        const order = await db.collection(COLLECTION_ORDERS).findOne({ _id: new ObjectId(orderId) });
        if (!order) {
            return res.status(404).json({ success: false, message: '주문 내역을 찾을 수 없습니다.' });
        }

        // 2. 비즈엠 템플릿 변수에 맞게 데이터 가공
        const customerName = order.customer_name || '고객';
        const storeName = order.store_name || '미지정';
        const contactPhone = order.customer_phone || receiver; 
        
        // 🔥 수정 1: 주소 필드명을 DB와 동일하게 'customer_address'로 변경
        const address = order.customer_address || '매장 직접 수령 (또는 미입력)';
        
        // 🔥 수정 2: 상품명 뒤에 [옵션명]을 붙이도록 로직 강화
        let productListText = '';
        if (order.items && order.items.length > 0) {
            productListText = order.items.map(item => {
                const name = item.product_name;
                // 옵션명이 존재하면 대괄호 [ ] 안에 넣어서 추가
                const option = item.option_name && item.option_name !== '.' ? ` [${item.option_name}]` : '';
                const qty = Number(item.quantity) || 1;
                return `- ${name}${option} (${qty}개)`;
            }).join('\n');
        } else {
            // items 배열이 없는 예전 데이터 예외 처리
            const name = order.product_name || '요기보 상품';
            const option = order.option_name && order.option_name !== '.' ? ` [${order.option_name}]` : '';
            const qty = Number(order.quantity) || 1;
            productListText = `- ${name}${option} (${qty}개)`;
        }

        // 금액 콤마 포맷팅
        const formatPrice = (num) => Number(num || 0).toLocaleString('ko-KR');
        const totalAmount = formatPrice(order.total_amount || 0);

        // 3. 템플릿 텍스트 조립 
        // ⚠️ 들여쓰기 절대 금지!
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

        // 4. 비즈엠 전송 페이로드 구성
        const payload = [{
            "message_type": "at",
            "phn": receiver.replace(/-/g, ''), // 번호 하이픈 제거
            "profile": BIZM_PROFILE_KEY,
            "tmplId": "off_receipt",           // 카카오에 승인된 템플릿 코드
            "msg": msgText,                    // 완성된 텍스트 통째로 삽입
            "button1": { 
                "name": "온라인몰 바로가기",      // 승인된 버튼명
                "type": "WL", 
                "url_mobile": "http://yogibo.kr",
                "url_pc": "http://yogibo.kr" 
            },
            "smsKind": "L",
            "smsMsg": msgText,                 // 카톡 실패 시 문자로 전송될 내용
            "smsSender": BIZM_SENDER_PHONE
        }];

        // 5. 비즈엠 API 호출
        const response = await axios.post('https://alimtalk-api.bizmsg.kr/v2/sender/send', payload, {
            headers: { 'userid': BIZM_USER_ID, 'Content-Type': 'application/json' }
        });

        res.json({ success: true, result: response.data });
    } catch (error) { 
        console.error("🔥 비즈엠 알림톡 발송 에러:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: '알림톡 발송 중 서버 에러가 발생했습니다.' }); 
    }
});