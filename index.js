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
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// [2] 환경변수 및 DB 설정
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "OFFLINE_ORDER"; 
const COLLECTION_ORDERS = "ordersOffData";
const COLLECTION_TOKENS = "tokens";

// Cafe24 설정
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const CAFE24_API_VERSION = '2025-12-01';

// 전역 변수
let db;
let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

// ==========================================
// [3] 서버 시작 (DB 연결 -> 서버 리슨)
// ==========================================
async function startServer() {
    try {
        console.log("-----------------------------------------");
        console.log("⏳ System Booting...");
        
        if (!MONGODB_URI) throw new Error("MONGODB_URI is missing in .env");
        if (!CAFE24_MALLID) throw new Error("CAFE24_MALLID is missing in .env");

        // DB 연결
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

        // 서버 실행
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
// [4] 토큰 갱신 함수 (API 요청 실패 시 자동 호출)
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

        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token;

        // 변수 및 DB 갱신
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

// 5-1. Cafe24 상품 검색 (이미지, 옵션 상세 로직 적용됨)
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        console.log(`🔍 Searching Product: "${keyword}"`);

        // 재시도 로직이 포함된 API 호출 내부 함수
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
                            // ★★★ 요청하신 핵심 부분: options와 images를 embed로 가져옴
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
            } catch (err) {
                // 토큰 만료(401) 시 1회 재시도
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

        // ★★★ [데이터 정제] 요청하신 로직 적용 (이미지, 옵션 추출)
        const cleanData = products.map(item => {
            // 1. 옵션 처리 (색상/컬러 우선 추출)
            let myOptions = [];
            let rawOptionList = [];

            if (item.options) {
                if (Array.isArray(item.options)) {
                    rawOptionList = item.options; 
                } else if (item.options.options && Array.isArray(item.options.options)) {
                    rawOptionList = item.options.options; 
                }
            }

            if (rawOptionList.length > 0) {
                // '색상', 'color', '컬러'가 포함된 옵션을 우선 찾음
                let targetOption = rawOptionList.find(opt => {
                    const name = (opt.option_name || opt.name || "").toLowerCase();
                    return name.includes('색상') || name.includes('color') || name.includes('컬러');
                });

                // 없으면 첫 번째 옵션을 사용
                if (!targetOption && rawOptionList.length > 0) {
                    targetOption = rawOptionList[0];
                }

                // 옵션 값 추출 (Code, Name 매핑)
                if (targetOption && targetOption.option_value) {
                    myOptions = targetOption.option_value.map(val => ({
                        option_code: val.value_no || val.value_code || val.value, 
                        option_name: val.value_name || val.option_text || val.name 
                    }));
                }
            }

            // 2. 이미지 URL 추출 (embed='images' 결과 활용)
            let detailImage = '';
            let listImage = '';
            let smallImage = '';

            // 2-1. 기본 필드 체크
            if (item.detail_image) detailImage = item.detail_image;
            if (item.list_image) listImage = item.list_image;
            if (item.small_image) smallImage = item.small_image;

            // 2-2. images 배열(embed 결과)에서 고화질 이미지 우선 확보
            if (item.images && Array.isArray(item.images) && item.images.length > 0) {
                const firstImage = item.images[0];
                if (!detailImage && firstImage.big) detailImage = firstImage.big;
                if (!listImage && firstImage.medium) listImage = firstImage.medium;
                if (!smallImage && firstImage.small) smallImage = firstImage.small;
            }

            // 2-3. 대체 이미지 필드 체크
            if (!detailImage && item.product_image) detailImage = item.product_image;
            if (!detailImage && item.image_url) detailImage = item.image_url;

            return {
                product_no: item.product_no,
                product_name: item.product_name,
                price: Math.floor(Number(item.price)),
                options: myOptions, // 정제된 옵션 리스트
                
                // 정제된 이미지 URL
                detail_image: detailImage,
                list_image: listImage,
                small_image: smallImage
            };
        });

        console.log(`[Cafe24] 검색 완료: ${cleanData.length}건 반환`);
        res.json({ success: true, count: cleanData.length, data: cleanData });

    } catch (error) {
        console.error("[Cafe24 API Error]:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "Cafe24 API Error" });
    }
});


// 5-2. 주문 저장 (오프라인 주문 DB)
app.post('/api/ordersOffData', async (req, res) => {
    try {
        const orderData = req.body;
        
        // items 배열 데이터 보정
        const items = orderData.items || [{
            product_name: orderData.product_name,
            option_name: orderData.option_name,
            price: 0,
            quantity: 1
        }];

        const newOrder = {
            ...orderData,
            items: items, 
            total_amount: Number(orderData.total_amount) || 0,
            shipping_cost: Number(orderData.shipping_cost) || 0,
            is_synced: false,
            created_at: new Date(),
            synced_at: null
        };
        
        delete newOrder._id; // 자동생성 ID 충돌 방지

        const result = await db.collection(COLLECTION_ORDERS).insertOne(newOrder);
        res.json({ success: true, message: "Order Saved", orderId: result.insertedId });

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

        if (store_name && store_name !== '전체' && store_name !== 'null') {
            query.store_name = store_name;
        }
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

// 5-4. ERP 전송 상태 업데이트
app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const { orderIds } = req.body; 
        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'No IDs' });
        }

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

// 5-5. 주문 삭제
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