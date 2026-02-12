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
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// [2] 환경변수 및 DB 설정
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "OFFLINE_ORDER"; 

// 컬렉션 정의
const COLLECTION_ORDERS = "ordersOffData";          // 주문 데이터 (휴지통 기능 포함)
const COLLECTION_TOKENS = "tokens";                 // 토큰 관리
const COLLECTION_STORES = "ecountStores";           // 매장 목록 (DB 관리)
const COLLECTION_STATIC_MANAGERS = "staticManagers";// 직원 목록 (DB 관리)
const COLLECTION_WAREHOUSES = "ecountWarehouses";   // ★ 창고 목록 (DB 관리)

const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const CAFE24_API_VERSION = '2025-12-01';

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

        // ★★★ [수정됨] JSON 파일 로드 삭제 -> 코드 내 데이터로 강제 초기화 ★★★
        // 기존: await seedCollectionFromJSON('ECOUNT_WAREHOUSE.json', COLLECTION_WAREHOUSES); (삭제)
        await initializeWarehouseDB(); // <--- 이걸로 교체!

        // (매장, 직원은 파일에서 로드 유지)
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

// ==========================================
// [3-1] ★ JSON -> MongoDB 시딩 유틸리티
// ==========================================
async function seedCollectionFromJSON(filename, collectionName) {
    try {
        const count = await db.collection(collectionName).countDocuments();
        if (count > 0) {
            console.log(`📋 [${collectionName}] 데이터 ${count}건 존재 → 시딩 스킵`);
            return;
        }

        const jsonPath = path.join(__dirname, filename);
        if (!fs.existsSync(jsonPath)) {
            console.log(`📋 [${collectionName}] 초기화용 ${filename} 없음 → 시딩 스킵`);
            return;
        }

        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);

        if (!Array.isArray(data) || data.length === 0) return;

        // DB 삽입 시 _id 충돌 방지를 위해 기존 데이터 정제
        const docs = data.map(item => {
            const { _id, ...rest } = item; 
            return { ...rest, created_at: new Date(), source: 'json_seed' };
        });

        const result = await db.collection(collectionName).insertMany(docs);
        console.log(`✅ [${collectionName}] JSON 데이터 시딩 완료: ${result.insertedCount}건`);
    } catch (e) {
        console.error(`⚠️ [${collectionName}] 시딩 오류:`, e.message);
    }
}

// ==========================================
// [4] 토큰 갱신 함수
// ==========================================
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
// [5] API 라우트 - Cafe24 (상품 조회)
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
                        params: { shop_no: 1, product_name: keyword, display: 'T', selling: 'T', embed: 'options,images', limit: 100 ,sort:'created_date',order:'asc'},
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
            let rawOptionList = [];
            if (item.options) {
                if (Array.isArray(item.options)) rawOptionList = item.options;
                else if (item.options.options) rawOptionList = item.options.options;
            }
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
// [6] ★★★ API 라우트 - 주문 CRUD (휴지통 기능 포함)
// ==========================================
// 6-1. 주문 조회 (필터링 + 휴지통 + 전송완료 뷰 구분)
app.get('/api/ordersOffData', async (req, res) => {
    try {
        const { store_name, startDate, endDate, keyword, view } = req.query;
        let query = {};

        // ★ [핵심 수정] 뷰 모드에 따른 필터링
        if (view === 'trash') {
            // 1. 휴지통: 삭제된 데이터만
            query.is_deleted = true;
        } else if (view === 'completed') {
            // 2. 전송완료: 삭제 안 되고 + 동기화 된(is_synced: true) 데이터
            query.is_deleted = { $ne: true };
            query.is_synced = true;
        } else {
            // 3. 기본(Active): 삭제 안 되고 + 아직 동기화 안 된(is_synced: false or null) 데이터
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

// 6-2. 주문 저장
app.post('/api/ordersOffData', async (req, res) => {
    try {
        const d = req.body;
        const items = d.items || [{ product_name: d.product_name, option_name: d.option_name, price: 0, quantity: 1 }];
        const newOrder = {
            ...d, items,
            total_amount: Number(d.total_amount) || 0,
            shipping_cost: Number(d.shipping_cost) || 0,
            is_synced: false, 
            is_deleted: false, // 기본값: 삭제 안됨
            created_at: new Date(), 
            synced_at: null
        };
        delete newOrder._id;
        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, message: "Order Saved", orderId: result.insertedId });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// 6-3. 주문 수정
app.put('/api/ordersOffData/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });
        
        const f = { ...req.body, updated_at: new Date() };
        delete f._id; // ID 수정 방지

        // 금액 등 숫자 변환
        if (f.shipping_cost !== undefined) f.shipping_cost = Number(f.shipping_cost);
        if (f.total_amount !== undefined) f.total_amount = Number(f.total_amount);

        await db.collection(COLLECTION_ORDERS).updateOne({ _id: new ObjectId(id) }, { $set: f });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// 6-4. ★ 주문 삭제 (Soft Delete & Hard Delete)
app.delete('/api/ordersOffData/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { type } = req.query; // ?type=hard 면 완전 삭제
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        if (type === 'hard') {
            // 영구 삭제
            const result = await db.collection(COLLECTION_ORDERS).deleteOne({ _id: new ObjectId(id) });
            res.json({ success: true, message: '영구 삭제됨' });
        } else {
            // 휴지통 이동 (Soft Delete)
            await db.collection(COLLECTION_ORDERS).updateOne(
                { _id: new ObjectId(id) },
                { $set: { is_deleted: true, deleted_at: new Date() } }
            );
            res.json({ success: true, message: '휴지통으로 이동됨' });
        }
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// 6-5. ★ 주문 복구 (Restore & Reset Sync)
app.put('/api/ordersOffData/restore/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        // 수정됨: 삭제 취소(is_deleted: false) + 전송 상태 초기화(is_synced: false)
        await db.collection(COLLECTION_ORDERS).updateOne(
            { _id: new ObjectId(id) },
            { 
                $set: { 
                    is_deleted: false, 
                    deleted_at: null,
                    is_synced: false,  // ★ 전송 완료 상태 해제
                    synced_at: null    // ★ 전송 시간 초기화
                } 
            }
        );
        res.json({ success: true, message: '상태가 초기화되었습니다.' });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});

// 6-6. ERP 동기화 처리
app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const { orderIds } = req.body;
        const objectIds = orderIds.map(id => new ObjectId(id));
        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { _id: { $in: objectIds } },
            { $set: { is_synced: true, synced_at: new Date() } }
        );
        res.json({ success: true, updatedCount: result.modifiedCount });
    } catch (error) { res.status(500).json({ success: false, message: 'DB Error' }); }
});


// =================================================================
// [7] ★★★ 정적 데이터 관리 (DB 사용) ★★★
// =================================================================

// 7-1. 품목코드 (ITEM_CODES.json) - 파일 유지 (읽기 전용)
app.get('/api/item-codes', (req, res) => {
    const filePath = path.join(__dirname, 'ITEM_CODES.json');
    if (!fs.existsSync(filePath)) return res.json({ success: true, count: 0, data: [] });
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json({ success: true, count: data.length, data: data });
    } catch {
        res.json({ success: true, count: 0, data: [] });
    }
});

// 7-2. 매장 목록 (ECOUNT_STORES) - DB 사용
app.get('/api/ecount-stores', async (req, res) => {
    try {
        const stores = await db.collection(COLLECTION_STORES).find({}).toArray();
        res.json({ success: true, count: stores.length, data: stores });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.put('/api/ecount-stores', async (req, res) => {
    try {
        const { data } = req.body;
        await db.collection(COLLECTION_STORES).deleteMany({});
        const cleanData = data.map(item => { const { _id, ...rest } = item; return { ...rest, updated_at: new Date() }; });
        if (cleanData.length > 0) await db.collection(COLLECTION_STORES).insertMany(cleanData);
        res.json({ success: true, count: cleanData.length });
    } catch (e) { res.status(500).json({ success: false }); }
});

// 7-3. 직원 목록 (STATIC_MANAGERS) - DB 사용
app.get('/api/static-managers', async (req, res) => {
    try {
        const managers = await db.collection(COLLECTION_STATIC_MANAGERS).find({}).toArray();
        res.json({ success: true, count: managers.length, data: managers });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.put('/api/static-managers', async (req, res) => {
    try {
        const { data } = req.body;
        await db.collection(COLLECTION_STATIC_MANAGERS).deleteMany({});
        const cleanData = data.map(item => { const { _id, ...rest } = item; return { ...rest, updated_at: new Date() }; });
        if (cleanData.length > 0) await db.collection(COLLECTION_STATIC_MANAGERS).insertMany(cleanData);
        res.json({ success: true, count: cleanData.length });
    } catch (e) { res.status(500).json({ success: false }); }
});

// 7-4. ★ 창고 목록 (ECOUNT_WAREHOUSES) - DB 사용
app.get('/api/ecount-warehouses', async (req, res) => {
    try {
        const warehouses = await db.collection(COLLECTION_WAREHOUSES).find({}).toArray();
        res.json({ success: true, count: warehouses.length, data: warehouses });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.put('/api/ecount-warehouses', async (req, res) => {
    try {
        const { data } = req.body;
        // 기존 데이터 삭제 후 일괄 삽입 (편집된 리스트로 갱신)
        await db.collection(COLLECTION_WAREHOUSES).deleteMany({});
        
        const cleanData = data.map(item => { 
            const { _id, ...rest } = item; 
            return { ...rest, updated_at: new Date() }; 
        });

        if (cleanData.length > 0) await db.collection(COLLECTION_WAREHOUSES).insertMany(cleanData);
        res.json({ success: true, count: cleanData.length });
    } catch (e) { res.status(500).json({ success: false }); }
});