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
        // DB 연결 실패해도 서버가 죽지 않게 하려면 아래 process.exit을 주석 처리 하세요.
        // 하지만 DB 없이는 의미가 없으므로 종료하는 게 맞습니다.
    }
}

// 서버 시작
startServer();

// 3-4. 공통 API 요청 함수 (무한 루프 방지 적용)
async function apiRequest(method, url, data = {}, params = {}, retryCount = 0) {
    try {
        const response = await axios({
            method, url, data, params,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Cafe24-Api-Version': CAFE24_API_VERSION
            },
        });
        return response.data;
    } catch (error) {
        // 401 에러이고, 재시도 횟수가 0일 때만 갱신 시도
        if (error.response && error.response.status === 401 && retryCount < 1) {
            console.log(`⚠️ [401 Error] Access Token 만료됨. 갱신 시도... (1회차)`);
            try {
                await refreshAccessToken(); 
                // 갱신 후 재요청 (retryCount를 1로 증가시켜 전달)
                return await apiRequest(method, url, data, params, retryCount + 1); 
            } catch (refreshError) {
                console.error("❌ 토큰 갱신 실패. 더 이상 재시도하지 않습니다.");
                throw refreshError;
            }
        } else {
            // 그 외 에러거나 이미 재시도한 경우 에러 그대로 반환
            console.error(`❌ API 요청 최종 실패: ${error.message}`);
            throw error;
        }
    }
}
apiRequest()

// --- API: 상품 검색 ---
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        console.log(`🔍 Searching Product: "${keyword}"`);

        // 토큰 갱신 등의 복잡한 로직은 일단 제외하고 호출만 시도 (디버깅용)
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