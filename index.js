const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// [1] 기본 설정
const app = express();
const PORT = process.env.PORT || 8080;

// CORS 허용 (모든 출처)
app.use(cors());
app.use(express.json());

// [2] 환경변수 로그 확인 (배포 시 로그 탭에서 확인용)
console.log("-----------------------------------------");
console.log("System Start Initialization...");
console.log("DB_URI Exists:", !!process.env.MONGODB_URI);
console.log("CAFE24_ID Exists:", !!process.env.CAFE24_CLIENT_ID);
console.log("-----------------------------------------");

// MongoDB 설정
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "OFFLINE_ORDER"; 
const COLLECTION_ORDERS = "ordersOffData";
const COLLECTION_TOKENS = "tokens";

// Cafe24 설정
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const CAFE24_API_VERSION = '2025-12-01';

let db;
let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

// [3] 서버 시작 함수 (DB 연결 -> 서버 실행 순서 보장)
async function startServer() {
    try {
        console.log("⏳ Connecting to MongoDB...");
        // DB 연결 시도
        const client = await MongoClient.connect(MONGODB_URI);
        console.log(`✅ MongoDB Connected to [${DB_NAME}]`);
        db = client.db(DB_NAME);

        // 토큰 로드 시도
        try {
            const tokenDoc = await db.collection(COLLECTION_TOKENS).findOne({});
            if (tokenDoc) {
                accessToken = tokenDoc.accessToken;
                refreshToken = tokenDoc.refreshToken;
                console.log("🔑 Token Loaded from DB");
            } else {
                console.log("⚠️ No token in DB, using env vars.");
            }
        } catch (e) {
            console.error("⚠️ Token Load Error (Ignored):", e.message);
        }

        // ★★★ 서버 실행 (여기서 딱 한 번만 실행됨) ★★★
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`);
        });

    } catch (err) {
        console.error("🔥 Critical Error - Server Failed to Start:");
        console.error(err);
    }
}

// 서버 시작 함수 호출
startServer();


// --- API: 상품 검색 ---
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        console.log(`🔍 Searching Product: "${keyword}"`);

        // Cafe24 API 호출
        const response = await axios.get(
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
                    'X-Cafe24-Api-Version': CAFE24_API_VERSION
                }
            }
        );

        const products = response.data.products || [];
        
        const cleanData = products.map(p => ({
            product_no: p.product_no,
            product_name: p.product_name,
            price: Math.floor(Number(p.price)),
            // 이미지 추출
            detail_image: (p.images && p.images[0] && p.images[0].big) || p.detail_image || '',
            list_image: (p.images && p.images[0] && p.images[0].medium) || p.list_image || '',
            small_image: (p.images && p.images[0] && p.images[0].small) || p.small_image || '',
            // 옵션 추출
            options: p.options && p.options.options 
                ? p.options.options.map(opt => ({
                    option_code: opt.value_no || opt.value_code,
                    option_name: opt.value_name || opt.option_text
                  })) 
                : []
        }));

        res.json({ success: true, count: cleanData.length, data: cleanData });

    } catch (error) {
        console.error("API Error Response:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            message: "Cafe24 API Error", 
            detail: error.response ? error.response.data : error.message 
        });
    }
});

// --- API: 주문 저장 ---
app.post('/api/ordersOffData', async (req, res) => {
    try {
        const orderData = req.body;
        orderData.created_at = new Date();
        orderData.is_synced = false;
        
        const result = await db.collection(COLLECTION_ORDERS).insertOne(orderData);
        res.json({ success: true, message: "Saved", orderId: result.insertedId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "DB Error" });
    }
});