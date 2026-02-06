const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// ==========================================
// [1] 서버 기본 설정
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;

// CORS 설정 (모든 도메인 허용)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// [2] 환경변수 체크 (에러 방지용)
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;

console.log("-----------------------------------------");
console.log("System Environment Check:");
console.log("▶ MongoDB URI:", MONGODB_URI ? "✅ Set" : "❌ Missing");
console.log("▶ Cafe24 Mall ID:", CAFE24_MALLID ? `✅ Set (${CAFE24_MALLID})` : "❌ Missing");
console.log("-----------------------------------------");

// DB 및 설정 변수
const DB_NAME = "OFFLINE_ORDER";
const COLLECTION_ORDERS = "ordersOffData";
const COLLECTION_TOKENS = "tokens";
let db;

// 토큰 변수 (메모리 캐싱)
let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

// ==========================================
// [3] 서버 시작 (DB 연결 -> 서버 리슨)
// ==========================================
async function startServer() {
    try {
        if (!MONGODB_URI) {
            throw new Error("MONGODB_URI가 환경변수에 없습니다.");
        }

        console.log("⏳ Connecting to MongoDB...");
        const client = await MongoClient.connect(MONGODB_URI);
        console.log(`✅ MongoDB Connected to [${DB_NAME}]`);
        db = client.db(DB_NAME);

        // DB에서 토큰 로드 시도
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

        // 서버 실행
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error("🔥 Server Failed to Start:");
        console.error(err);
    }
}

startServer();


// ==========================================
// [4] 토큰 갱신 함수
// ==========================================
async function refreshAccessToken() {
    console.log(`🚨 Refreshing Access Token...`);
    try {
        if (!CAFE24_MALLID) throw new Error("CAFE24_MALLID is missing");

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

        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token;

        // 메모리 및 DB 갱신
        accessToken = newAccessToken;
        refreshToken = newRefreshToken;

        if (db) {
            await db.collection(COLLECTION_TOKENS).updateOne(
                {}, 
                { $set: { accessToken: newAccessToken, refreshToken: newRefreshToken, updatedAt: new Date() } }, 
                { upsert: true }
            );
        }
        
        console.log(`✅ Token Refreshed Successfully`);
        return newAccessToken;

    } catch (error) {
        console.error(`❌ Token Refresh Failed:`, error.response ? error.response.data : error.message);
        throw error;
    }
}


// ==========================================
// [5] API 라우트
// ==========================================

// 5-1. Cafe24 상품 검색 (재시도 로직 포함)
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        if (!CAFE24_MALLID) {
            return res.status(500).json({ success: false, message: "Server Config Error: Missing Mall ID" });
        }

        console.log(`🔍 Searching Product: "${keyword}"`);

        // API 호출 함수 내부 정의 (재귀 호출 용이성)
        const fetchFromCafe24 = async (retry = false) => {
            try {
                return await axios.get(
                    `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
                    {
                        params: {
                            shop_no: 1,
                            product_name: keyword,
                            display: 'T',
                            selling: 'T',
                            embed: 'options,images',
                            limit: 50
                        },
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                            'X-Cafe24-Api-Version': '2025-12-01'
                        }
                    }
                );
            } catch (err) {
                // 401 에러이고 아직 재시도 안했으면 토큰 갱신 후 재시도
                if (err.response && err.response.status === 401 && !retry) {
                    console.log("⚠️ Token expired. Refreshing...");
                    await refreshAccessToken();
                    return await fetchFromCafe24(true); // 한 번만 재시도
                }
                throw err;
            }
        };

        const response = await fetchFromCafe24();
        const products = response.data.products || [];

        // 데이터 정제
        const cleanData = products.map(p => ({
            product_no: p.product_no,
            product_name: p.product_name,
            price: Math.floor(Number(p.price)),
            // 이미지
            detail_image: (p.images && p.images[0] && p.images[0].big) || p.detail_image || '',
            list_image: (p.images && p.images[0] && p.images[0].medium) || p.list_image || '',
            small_image: (p.images && p.images[0] && p.images[0].small) || p.small_image || '',
            // 옵션
            options: p.options && p.options.options ? p.options.options.map(opt => ({
                option_code: opt.value_no || opt.value_code,
                option_name: opt.value_name || opt.option_text
            })) : []
        }));

        res.json({ success: true, count: cleanData.length, data: cleanData });

    } catch (error) {
        console.error("[Cafe24 API Error]:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
    }
});

// 5-2. 주문 저장
app.post('/api/ordersOffData', async (req, res) => {
    try {
        const orderData = req.body;
        
        // 필수 데이터 보정
        const items = orderData.items || [{
            product_name: orderData.product_name,
            option_name: orderData.option_name,
            price: 0,
            quantity: 1
        }];

        const newOrder = {
            ...orderData,
            items: items, // items 배열 보장
            total_amount: Number(orderData.total_amount) || 0,
            shipping_cost: Number(orderData.shipping_cost) || 0,
            is_synced: false,
            created_at: new Date(),
            synced_at: null
        };
        
        // _id 필드가 혹시 들어왔으면 제거 (MongoDB가 자동 생성)
        delete newOrder._id; 

        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, message: "Saved", orderId: result.insertedId });

    } catch (error) {
        console.error('Order Save Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 5-3. 주문 조회
app.get('/api/ordersOffData', async (req, res) => {
    try {
        const { store_name, startDate, endDate, keyword } = req.query;
        let query = {};

        if (store_name && store_name !== '전체') query.store_name = store_name;
        if (startDate && endDate) {
            query.created_at = {
                $gte: new Date(startDate + "T00:00:00.000Z"),
                $lte: new Date(endDate + "T23:59:59.999Z")
            };
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

// 5-4. ERP 동기화
app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const { orderIds } = req.body;
        if (!orderIds || !Array.isArray(orderIds)) return res.status(400).json({ success: false });

        const objectIds = orderIds.map(id => new ObjectId(id));
        const result = await db.collection(COLLECTION_ORDERS).updateMany(
            { _id: { $in: objectIds } },
            { $set: { is_synced: true, synced_at: new Date() } }
        );
        res.json({ success: true, updatedCount: result.modifiedCount });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 5-5. 주문 삭제
app.delete('/api/ordersOffData/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        const result = await db.collection(COLLECTION_ORDERS).deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) res.json({ success: true });
        else res.status(404).json({ success: false });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});