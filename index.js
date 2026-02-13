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

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'userid'] // userid 허용 (비즈엠용)
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// [2] 환경변수 및 DB 컬렉션 설정
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "OFFLINE_ORDER"; 

const COLLECTION_ORDERS = "ordersOffData";          // 주문 데이터
const COLLECTION_TOKENS = "tokens";                 // 토큰 관리
const COLLECTION_STORES = "ecountStores";           // 매장 목록
const COLLECTION_STATIC_MANAGERS = "staticManagers";// 직원 목록
const COLLECTION_WAREHOUSES = "ecountWarehouses";   // 창고 목록
const COLLECTION_CS_MEMOS = "csMemos";              // CS 메모
const COLLECTION_CREDENTIALS = "storeCredentials";  // 매장 비밀번호 관리

// API 및 외부 연동 설정
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const CAFE24_API_VERSION = '2025-12-01';

const BIZM_USER_ID = process.env.BIZM_USER_ID;
const BIZM_PROFILE_KEY = process.env.BIZM_PROFILE_KEY;
const BIZM_SENDER_PHONE = process.env.BIZM_SENDER_PHONE;
const MY_DOMAIN = process.env.MY_DOMAIN || "https://yogibo.kr"; // 영수증 URL용 도메인

let db;
let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

// ==========================================
// [3] 서버 시작 (DB 연결 → 시딩 → 리슨)
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

        // 토큰 로드
        try {
            const tokenDoc = await db.collection(COLLECTION_TOKENS).findOne({});
            if (tokenDoc) {
                accessToken = tokenDoc.accessToken;
                refreshToken = tokenDoc.refreshToken;
                console.log("🔑 Token Loaded from DB");
            }
        } catch (e) { console.error("⚠️ Token Load Warning:", e.message); }

        await initializeWarehouseDB(); 
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

// JSON 시딩 유틸리티
async function seedCollectionFromJSON(filename, collectionName) {
    try {
        const count = await db.collection(collectionName).countDocuments();
        if (count > 0) { console.log(`📋 [${collectionName}] 데이터 존재 → 시딩 스킵`); return; }

        const jsonPath = path.join(__dirname, filename);
        if (!fs.existsSync(jsonPath)) { console.log(`📋 [${collectionName}] 초기화 파일 없음 → 시딩 스킵`); return; }

        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);

        if (!Array.isArray(data) || data.length === 0) return;

        const docs = data.map(item => {
            const { _id, ...rest } = item; 
            return { ...rest, created_at: new Date(), source: 'json_seed' };
        });

        await db.collection(collectionName).insertMany(docs);
        console.log(`✅ [${collectionName}] JSON 시딩 완료: ${docs.length}건`);
    } catch (e) { console.error(`⚠️ [${collectionName}] 시딩 오류:`, e.message); }
}

// 창고 데이터 초기화
async function initializeWarehouseDB() {
    try {
        const collection = db.collection(COLLECTION_WAREHOUSES);
        const count = await collection.countDocuments();
        if (count === 0) {
            console.log("📋 [ECOUNT_WAREHOUSES] 기본 창고 데이터 삽입 중...");
            const defaultWarehouses = [
                { warehouse_code: 'C0001', warehouse_name: '판매입력(물류센터) (기본)', created_at: new Date() }
            ];
            await collection.insertMany(defaultWarehouses);
            console.log("✅ 기본 창고 데이터 초기화 완료");
        }
    } catch (e) { console.error("⚠️ 창고 DB 초기화 오류:", e.message); }
}

// 토큰 갱신
async function refreshAccessToken() {
    console.log(`🚨 Refreshing Access Token...`);
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
// [4] 매장 접속 권한 관리 (비밀번호)
// ==========================================

// 4-1. 매장 비밀번호 설정/저장 (Admin용)
app.post('/api/auth/store/password', async (req, res) => {
    try {
        const { storeName, password } = req.body;
        if (!storeName || !password) return res.status(400).json({ success: false, message: '값 누락' });

        await db.collection(COLLECTION_CREDENTIALS).updateOne(
            { storeName: storeName }, 
            { $set: { password: password, updatedAt: new Date() } }, 
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// 4-2. 매장 로그인 검증 (Manager용)
app.post('/api/auth/store/login', async (req, res) => {
    try {
        const { storeName, password } = req.body;
        const cred = await db.collection(COLLECTION_CREDENTIALS).findOne({ storeName: storeName });
        
        if (cred && cred.password === password) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    } catch (e) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// 4-3. 전체 매장 비밀번호 조회 (Admin용)
app.get('/api/auth/store/credentials', async (req, res) => {
    try {
        const credentials = await db.collection(COLLECTION_CREDENTIALS).find({}).toArray();
        res.json({ success: true, data: credentials });
    } catch (e) { res.status(500).json({ success: false, message: 'DB Error' }); }
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
// [6] 주문 데이터 CRUD (미전송/완료/휴지통)
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
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

app.post('/api/ordersOffData', async (req, res) => {
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

app.put('/api/ordersOffData/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });
        
        const f = { ...req.body, updated_at: new Date() };
        delete f._id;
        if (f.shipping_cost !== undefined) f.shipping_cost = Number(f.shipping_cost);
        if (f.total_amount !== undefined) f.total_amount = Number(f.total_amount);

        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(id) }, { $set: f });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

app.delete('/api/ordersOffData/:id', async (req, res) => {
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
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

app.put('/api/ordersOffData/restore/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        await db.collection(COLLECTION_ORDERS).updateOne(
            { _id: new ObjectId(id) },
            { $set: { is_deleted: false, deleted_at: null, is_synced: false, synced_at: null, ecount_status: null, ecount_message: null } }
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// ERP 동기화 처리 (성공/실패)
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
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
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
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// ==========================================
// [7] 정적 데이터 관리 (DB 연동)
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

// ==========================================
// [8] CS 메모 관리
// ==========================================
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
// [9] 비즈앱 알림톡
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
    } catch (error) {
        console.error("알림톡 전송 에러:", error.response?.data || error.message);
        res.status(500).json({ success: false });
    }
});