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

// ★ 컬렉션 정의 (모든 관리 항목 DB화)
const COLLECTION_ORDERS = "ordersOffData";
const COLLECTION_TOKENS = "tokens";
const COLLECTION_MAPPINGS = "managerMappings";      // 매니저-매장 매핑
const COLLECTION_STORES = "ecountStores";           // 거래처 목록
const COLLECTION_STATIC_MANAGERS = "staticManagers";// 직원 목록
const COLLECTION_WAREHOUSES = "ecountWarehouses";   // ★ 추가: 창고 목록

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
            } else {
                console.log("⚠️ No token in DB. Using environment variables.");
            }
        } catch (e) {
            console.error("⚠️ Token Load Warning:", e.message);
        }

        // ★ [DB 마이그레이션] JSON -> MongoDB 자동 시딩 (창고 포함)
        await seedCollectionFromJSON('managers.json', COLLECTION_MAPPINGS);
        await seedCollectionFromJSON('ECOUNT_STORES.json', COLLECTION_STORES);
        await seedCollectionFromJSON('STATIC_MANAGER_LIST.json', COLLECTION_STATIC_MANAGERS);
        await seedCollectionFromJSON('ECOUNT_WAREHOUSE.json', COLLECTION_WAREHOUSES); // ★ 창고 자동 시딩 추가

        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error("🔥 Critical Error - Server Failed to Start:");
        console.error(err);
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

        if (!Array.isArray(data) || data.length === 0) {
            console.log(`📋 [${collectionName}] JSON 파일 비어있음 → 시딩 스킵`);
            return;
        }

        // DB 삽입 시 _id 충돌 방지를 위해 기존 데이터 정제
        const docs = data.map(item => {
            const { _id, ...rest } = item; 
            return { ...rest, created_at: new Date(), source: 'json_seed' };
        });

        const result = await db.collection(collectionName).insertMany(docs);
        console.log(`✅ [${collectionName}] 초기 데이터 시딩 완료: ${result.insertedCount}건`);
    } catch (e) {
        console.error(`⚠️ [${collectionName}] 시딩 오류:`, e.message);
    }
}

// ==========================================
// [4] 토큰 갱신 함수 (Cafe24)
// ==========================================
async function refreshAccessToken() {
    console.log(`🚨 Refreshing Access Token...`);
    try {
        const basicAuth = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
        
        const response = await axios.post(
            `https://${CAFE24_MALLID}.cafe24api.com/api/v2/oauth/token`,
            `grant_type=refresh_token&refresh_token=${refreshToken}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`,
                },
            }
        );

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        if (db) {
            await db.collection(COLLECTION_TOKENS).updateOne(
                {}, 
                { $set: { accessToken, refreshToken, updatedAt: new Date() } }, 
                { upsert: true }
            );
        }
        
        console.log(`✅ Token Refreshed Successfully`);
        return accessToken;

    } catch (error) {
        console.error(`❌ Token Refresh Failed:`, error.response ? error.response.data : error.message);
        throw error;
    }
}

// ==========================================
// [5] API 라우트 - Cafe24 (상품/옵션 검색)
// ==========================================
// (기존 코드와 동일 - 생략 없이 포함되어야 함)
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        console.log(`🔍 Searching Product: "${keyword}"`);

        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                    {
                        params: { shop_no: 1, product_name: keyword, display: 'T', selling: 'T', embed: 'options,images', limit: 50 },
                        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }
                    }
                );
            } catch (err) {
                if (err.response && err.response.status === 401 && !retry) {
                    console.log("⚠️ Token expired. Refreshing...");
                    await refreshAccessToken();
                    return await fetchFromCafe24(true);
                }
                throw err;
            }
        };

        const response = await fetchFromCafe24();
        const products = response.data.products || [];

        const cleanData = products.map(item => {
            let myOptions = [], rawOptionList = [];
            if (item.options) {
                if (Array.isArray(item.options)) rawOptionList = item.options;
                else if (item.options.options && Array.isArray(item.options.options)) rawOptionList = item.options.options;
            }
            if (rawOptionList.length > 0) {
                let targetOption = rawOptionList.find(opt => {
                    const name = (opt.option_name || opt.name || "").toLowerCase();
                    return name.includes('색상') || name.includes('color') || name.includes('컬러');
                });
                if (!targetOption) targetOption = rawOptionList[0];
                if (targetOption && targetOption.option_value) {
                    myOptions = targetOption.option_value.map(val => ({
                        option_code: val.value_no || val.value_code || val.value,
                        option_name: val.value_name || val.option_text || val.name
                    }));
                }
            }

            let detailImage = '', listImage = '', smallImage = '';
            if (item.detail_image) detailImage = item.detail_image;
            if (item.list_image) listImage = item.list_image;
            if (item.small_image) smallImage = item.small_image;
            if (item.images && Array.isArray(item.images) && item.images.length > 0) {
                const fi = item.images[0];
                if (!detailImage && fi.big) detailImage = fi.big;
                if (!listImage && fi.medium) listImage = fi.medium;
                if (!smallImage && fi.small) smallImage = fi.small;
            }
            if (!detailImage && item.product_image) detailImage = item.product_image;
            if (!detailImage && item.image_url) detailImage = item.image_url;

            return {
                product_no: item.product_no, product_name: item.product_name,
                price: Math.floor(Number(item.price)), options: myOptions,
                detail_image: detailImage, list_image: listImage, small_image: smallImage
            };
        });

        res.json({ success: true, count: cleanData.length, data: cleanData });

    } catch (error) {
        console.error("[Cafe24 API Error]:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
    }
});

app.get('/api/cafe24/products/:productNo/options', async (req, res) => {
    try {
        const { productNo } = req.params;
        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${productNo}`,
                    {
                        params: { shop_no: 1, embed: 'options' },
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
        const product = response.data.product;
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

        let myOptions = [], rawOptionList = [];
        if (product.options) {
            if (Array.isArray(product.options)) rawOptionList = product.options;
            else if (product.options.options && Array.isArray(product.options.options)) rawOptionList = product.options.options;
        }
        if (rawOptionList.length > 0) {
            let targetOption = rawOptionList.find(opt => {
                const name = (opt.option_name || opt.name || "").toLowerCase();
                return name.includes('색상') || name.includes('color') || name.includes('컬러');
            });
            if (!targetOption) targetOption = rawOptionList[0];
            if (targetOption && targetOption.option_value) {
                myOptions = targetOption.option_value.map(val => ({
                    option_code: val.value_no || val.value_code || val.value,
                    option_name: val.value_name || val.option_text || val.name
                }));
            }
        }

        res.json({ success: true, product_no: product.product_no, product_name: product.product_name, options: myOptions });

    } catch (error) {
        console.error("[Cafe24 Option API Error]:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
    }
});


// ==========================================
// [6] API 라우트 - 주문 CRUD
// ==========================================
app.post('/api/ordersOffData', async (req, res) => {
    try {
        const d = req.body;
        const items = d.items || [{ product_name: d.product_name, option_name: d.option_name, price: 0, quantity: 1 }];
        const newOrder = {
            ...d, items,
            total_amount: Number(d.total_amount) || 0,
            shipping_cost: Number(d.shipping_cost) || 0,
            is_synced: false, created_at: new Date(), synced_at: null
        };
        delete newOrder._id;
        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, message: "Order Saved", orderId: result.insertedId });
    } catch (error) {
        console.error('Order Save Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.get('/api/ordersOffData', async (req, res) => {
    try {
        const { store_name, startDate, endDate, keyword } = req.query;
        let query = {};
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
    } catch (error) {
        console.error('Order List Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.put('/api/ordersOffData/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
        
        const u = req.body;
        const f = {};
        // 허용 필드
        ['store_name','customer_name','customer_phone','customer_address',
         'manager_name','manager_code','payment_method','promotion1','promotion2',
         'warehouse','marketing_consent','set_purchase','cover_purchase',
         'shipping_memo','product_name','sales_type'
        ].forEach(k => { if (u[k] !== undefined) f[k] = u[k]; });

        if (u.shipping_cost !== undefined) f.shipping_cost = Number(u.shipping_cost);
        if (u.total_amount !== undefined) f.total_amount = Number(u.total_amount);

        if (u.items && Array.isArray(u.items)) {
            f.items = u.items.map(item => ({
                product_no: item.product_no || null,
                product_name: item.product_name || '',
                option_name: item.option_name || '',
                price: Number(item.price) || 0,
                quantity: Number(item.quantity) || 1
            }));
        }

        f.updated_at = new Date();
        const result = await db.collection(COLLECTION_ORDERS).updateOne(
            { _id: new ObjectId(id) }, { $set: f }
        );
        if (result.matchedCount === 0) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, message: 'Order Updated' });
    } catch (error) {
        console.error('Order Update Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.delete('/api/ordersOffData/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });
        const result = await db.collection(COLLECTION_ORDERS).deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) res.json({ success: true });
        else res.status(404).json({ success: false });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const { orderIds } = req.body;
        if (!orderIds || !Array.isArray(orderIds)) return res.status(400).json({ success: false, message: 'No IDs' });
        const objectIds = orderIds.map(id => new ObjectId(id));
        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { _id: { $in: objectIds } },
            { $set: { is_synced: true, synced_at: new Date() } }
        );
        res.json({ success: true, updatedCount: result.modifiedCount });
    } catch (error) {
        console.error('Sync Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});


// ==========================================
// [7] 매니저 매핑 (Mapping) CRUD
// ==========================================
app.get('/api/mappings', async (req, res) => {
    try {
        const mappings = await db.collection(COLLECTION_MAPPINGS).find({}).sort({ manager_name: 1 }).toArray();
        res.json({ success: true, count: mappings.length, data: mappings });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.post('/api/mappings', async (req, res) => {
    try {
        const { manager_code, manager_name, store_name, store_code, warehouse, trade_type } = req.body;
        const doc = {
            manager_code: manager_code || '',
            manager_name: manager_name || '',
            store_name: store_name || '',
            store_code: store_code || '',
            warehouse: warehouse || 'Y000',
            trade_type: trade_type || '부가세율 적용',
            created_at: new Date()
        };
        const result = await db.collection(COLLECTION_MAPPINGS).insertOne(doc);
        res.json({ success: true, id: result.insertedId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.put('/api/mappings/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });
        const u = req.body, f = {};
        ['manager_code','manager_name','store_name','store_code','warehouse','trade_type']
            .forEach(k => { if (u[k] !== undefined) f[k] = u[k]; });
        f.updated_at = new Date();
        await db.collection(COLLECTION_MAPPINGS).updateOne({ _id: new ObjectId(id) }, { $set: f });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

app.delete('/api/mappings/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });
        await db.collection(COLLECTION_MAPPINGS).deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});


// =================================================================
// [8] ★★★ DB 기반 정적 데이터 관리 (Store, Manager, Warehouse) ★★★
// =================================================================

function loadJsonFile(filename) {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return []; }
}

// 8-1. 품목코드 (ITEM_CODES.json) - 읽기 전용 (JSON 유지)
let cachedItemCodes = null;
app.get('/api/item-codes', (req, res) => {
    if (!cachedItemCodes) cachedItemCodes = loadJsonFile('ITEM_CODES.json');
    res.json({ success: true, count: cachedItemCodes.length, data: cachedItemCodes });
});

// 8-2. ★ 거래처 목록 (ECOUNT_STORES) - DB 사용
app.get('/api/ecount-stores', async (req, res) => {
    try {
        const stores = await db.collection(COLLECTION_STORES).find({}).toArray();
        res.json({ success: true, count: stores.length, data: stores });
    } catch (e) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});
app.put('/api/ecount-stores', async (req, res) => {
    try {
        const { data } = req.body;
        if (!Array.isArray(data)) return res.status(400).json({ success: false, message: 'Invalid data' });
        await db.collection(COLLECTION_STORES).deleteMany({});
        const cleanData = data.map(item => { const { _id, ...rest } = item; return { ...rest, updated_at: new Date() }; });
        if (cleanData.length > 0) await db.collection(COLLECTION_STORES).insertMany(cleanData);
        res.json({ success: true, count: cleanData.length });
    } catch (e) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 8-3. ★ 담당자 목록 (STATIC_MANAGERS) - DB 사용
app.get('/api/static-managers', async (req, res) => {
    try {
        const managers = await db.collection(COLLECTION_STATIC_MANAGERS).find({}).toArray();
        res.json({ success: true, count: managers.length, data: managers });
    } catch (e) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});
app.put('/api/static-managers', async (req, res) => {
    try {
        const { data } = req.body;
        if (!Array.isArray(data)) return res.status(400).json({ success: false, message: 'Invalid data' });
        await db.collection(COLLECTION_STATIC_MANAGERS).deleteMany({});
        const cleanData = data.map(item => { const { _id, ...rest } = item; return { ...rest, updated_at: new Date() }; });
        if (cleanData.length > 0) await db.collection(COLLECTION_STATIC_MANAGERS).insertMany(cleanData);
        res.json({ success: true, count: cleanData.length });
    } catch (e) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 8-4. ★ 창고 목록 (ECOUNT_WAREHOUSES) - ★ DB 사용으로 변경!
app.get('/api/ecount-warehouses', async (req, res) => {
    try {
        const warehouses = await db.collection(COLLECTION_WAREHOUSES).find({}).toArray();
        res.json({ success: true, count: warehouses.length, data: warehouses });
    } catch (e) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});
// 창고 목록 저장 (프론트엔드 편집 대비)
app.put('/api/ecount-warehouses', async (req, res) => {
    try {
        const { data } = req.body;
        if (!Array.isArray(data)) return res.status(400).json({ success: false, message: 'Invalid data' });
        
        await db.collection(COLLECTION_WAREHOUSES).deleteMany({}); // 기존 데이터 삭제
        
        const cleanData = data.map(item => { 
            const { _id, ...rest } = item; 
            return { ...rest, updated_at: new Date() }; 
        });

        if (cleanData.length > 0) await db.collection(COLLECTION_WAREHOUSES).insertMany(cleanData);
        
        console.log(`💾 DB: ECOUNT_WAREHOUSES 갱신 완료 (${cleanData.length}건)`);
        res.json({ success: true, count: cleanData.length });
    } catch (e) {
        console.error('ECOUNT_WAREHOUSES Save Error:', e);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});