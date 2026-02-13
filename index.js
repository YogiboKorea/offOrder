const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// ==========================================
// [1] 서버 기본 설정 및 CORS 상세 세팅
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;

// 허용할 도메인 목록
const whitelist = [
    'https://yogibo.kr',
    'https://www.yogibo.kr',
    'http://skin-skin123.yogibo.cafe24.com', // 테스트 스킨 (http)
    'https://skin-skin123.yogibo.cafe24.com' // 테스트 스킨 (https)
];

app.use(cors({
    origin: function (origin, callback) {
        // origin이 없거나(서버간 통신) whitelist에 있거나 cafe24 도메인이 포함되면 허용
        if (!origin || whitelist.indexOf(origin) !== -1 || origin.includes('cafe24.com')) {
            callback(null, true);
        } else {
            console.log("🚫 CORS Blocked Origin:", origin);
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
// [3] 서버 시작 (DB 연결 → 시딩 → 리슨)
// ==========================================
async function startServer() {
    try {
        console.log("-----------------------------------------");
        console.log("⏳ System Booting...");
        
        if (!MONGODB_URI) throw new Error("MONGODB_URI is missing in .env");
        if (!CAFE24_MALLID) throw new Error("CAFE24_MALLID is missing in .env");

        const client = await MongoClient.connect(MONGODB_URI);
        db = client.db(DB_NAME);
        console.log(`✅ MongoDB Connected to [${DB_NAME}]`);

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
            await db.collection(COLLECTION_AUTH).insertOne({ 
                type: 'global_pin', 
                pinCode: '111', 
                created_at: new Date() 
            });
            console.log("✅ 기본 매장 접속 비밀번호(111) 초기화 완료");
        }
    } catch (e) {
        console.error("⚠️ 비밀번호 DB 초기화 오류:", e.message);
    }
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
// [4] 인증 API 및 미들웨어 (401 해결의 핵심)
// ==========================================

app.post('/api/verify-pin', async (req, res) => {
    try {
        const { pin } = req.body;
        const setting = await db.collection(COLLECTION_AUTH).findOne({ type: 'global_pin' });
        
        // ★ 데이터 타입(숫자/문자열)에 상관없이 비교하기 위해 String으로 변환
        if (setting && String(setting.pinCode) === String(pin)) {
            res.json({ success: true, token: pin });
        } else {
            res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log("❌ 401 Error: Authorization Header missing or invalid");
        return res.status(401).json({ success: false, message: '인증 정보가 누락되었습니다.' });
    }

    const token = authHeader.split(' ')[1]; 
    try {
        const setting = await db.collection(COLLECTION_AUTH).findOne({ type: 'global_pin' });
        // ★ 데이터 타입 일치를 위해 String 강제 변환
        if (!setting || String(setting.pinCode) !== String(token)) {
            console.log("❌ 403 Error: Token Mismatch. Client sent:", token);
            return res.status(403).json({ success: false, message: '유효하지 않은 토큰입니다.' });
        }
        next(); 
    } catch(e) {
        res.status(500).json({ success: false });
    }
};

// ==========================================
// [5] Cafe24 API (기존 로직 유지)
// ==========================================
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });
        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(`https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {
                    params: { shop_no: 1, product_name: keyword, display: 'T', selling: 'T', embed: 'options,images', limit: 100 },
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                });
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
                let targetOption = rawOptionList.find(opt => (opt.option_name || "").toLowerCase().includes('색상')) || rawOptionList[0];
                if (targetOption && targetOption.option_value) {
                    myOptions = targetOption.option_value.map(val => ({ option_code: val.value_no || val.value, option_name: val.value_name || val.name }));
                }
            }
            return { product_no: item.product_no, product_name: item.product_name, price: Math.floor(Number(item.price)), options: myOptions, detail_image: item.detail_image };
        });
        res.json({ success: true, count: cleanData.length, data: cleanData });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// [6] 주문 CRUD (인증 미들웨어 적용)
// ==========================================
app.post('/api/ordersOffData', authMiddleware, async (req, res) => {
    try {
        const d = req.body;
        const newOrder = { ...d, is_synced: false, is_deleted: false, created_at: new Date() };
        delete newOrder._id;
        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, message: "Order Saved", orderId: result.insertedId });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const f = { ...req.body, updated_at: new Date() };
        delete f._id;
        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(id) }, { $set: f });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/ordersOffData/:id', authMiddleware, async (req, res) => {
    try {
        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(req.params.id) }, { $set: { is_deleted: true, deleted_at: new Date() } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// [기타] 매장 로그인 및 알림톡 (기존 유지)
// ==========================================
app.get('/api/ordersOffData', async (req, res) => {
    try {
        const { store_name, view } = req.query;
        let query = { is_deleted: view === 'trash' };
        if (store_name && store_name !== '전체') query.store_name = store_name;
        const orders = await db.collection(COLLECTION_ORDERS).find(query).sort({ created_at: -1 }).toArray();
        res.json({ success: true, data: orders });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/ecount-stores', async (req, res) => { res.json({ success: true, data: await db.collection(COLLECTION_STORES).find({}).toArray() }); });
app.get('/api/static-managers', async (req, res) => { res.json({ success: true, data: await db.collection(COLLECTION_STATIC_MANAGERS).find({}).toArray() }); });
app.get('/api/ecount-warehouses', async (req, res) => { res.json({ success: true, data: await db.collection(COLLECTION_WAREHOUSES).find({}).toArray() }); });

app.post('/api/auth/store/login', async (req, res) => {
    const { storeName, password } = req.body;
    const cred = await db.collection(COLLECTION_CREDENTIALS).findOne({ storeName });
    if (cred && cred.password === password) res.json({ success: true });
    else res.status(401).json({ success: false });
});


//비즈엠 로그인 연동부분
app.post('/api/send-alimtalk', async (req, res) => {
    try {
        const { orderId, receiver } = req.body;
        const receiptUrl = `${MY_DOMAIN}/receipt/${orderId}`;
        const payload = [{ "phn": receiver.replace(/-/g, ''), "profile": BIZM_PROFILE_KEY, "msg": `[Yogibo] 주문안내 영수증: ${receiptUrl}` }];
        await axios.post('https://alimtalk-api.bizmsg.kr/v2/sender/send', payload, { headers: { 'userid': BIZM_USER_ID, 'Content-Type': 'application/json' } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});