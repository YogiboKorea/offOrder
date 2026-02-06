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



// 5-1. Cafe24 상품 검색 (옵션 추출 로직 수정됨)
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        if (!CAFE24_MALLID) {
            return res.status(500).json({ success: false, message: "Server Config Error: Missing Mall ID" });
        }

        console.log(`🔍 Searching Product: "${keyword}"`);

        // API 호출 함수
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

        // ★★★ [핵심 수정] 옵션 데이터 정제 로직 강화 ★★★
        const cleanData = products.map(p => {
            let myOptions = [];
            
            // 카페24 응답 구조가 상황에 따라 다를 수 있어 안전하게 추출
            // 보통 p.options.options 배열 안에 { name: "색상", option_value: [...] } 형태로 들어있음
            let optionList = [];
            if (p.options) {
                if (Array.isArray(p.options)) optionList = p.options;
                else if (p.options.options && Array.isArray(p.options.options)) optionList = p.options.options;
            }

            if (optionList.length > 0) {
                // 옵션 목록 중 '색상'이나 '컬러'가 포함된 옵션을 우선 찾음
                let targetOption = optionList.find(opt => {
                    const name = (opt.option_name || opt.name || "").toLowerCase();
                    return name.includes('색상') || name.includes('color') || name.includes('컬러');
                });

                // 없으면 첫 번째 옵션 사용 (예: 사이즈 등)
                if (!targetOption) {
                    targetOption = optionList[0];
                }

                // 해당 옵션의 세부 값들(Red, Blue 등)을 추출
                if (targetOption && targetOption.option_value) {
                    myOptions = targetOption.option_value.map(val => ({
                        option_code: val.value_no || val.value_code,
                        option_name: val.value_name || val.option_text || val.name
                    }));
                }
            }

            return {
                product_no: p.product_no,
                product_name: p.product_name,
                price: Math.floor(Number(p.price)),
                // 이미지 추출
                detail_image: (p.images && p.images[0] && p.images[0].big) || p.detail_image || '',
                list_image: (p.images && p.images[0] && p.images[0].medium) || p.list_image || '',
                small_image: (p.images && p.images[0] && p.images[0].small) || p.small_image || '',
                // 추출된 옵션 리스트 할당
                options: myOptions 
            };
        });

        res.json({ success: true, count: cleanData.length, data: cleanData });

    } catch (error) {
        console.error("[Cafe24 API Error]:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
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