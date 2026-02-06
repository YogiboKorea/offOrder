const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// ==========================================
// [1] 환경변수 및 전역 설정
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;

// CORS 설정 (가장 먼저 적용)
app.use(cors({
    origin: '*', // 모든 도메인 허용
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 미들웨어 설정
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// MongoDB 설정
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "OFFLINE_ORDER"; 
const COLLECTION_ORDERS = "ordersOffData";
const COLLECTION_TOKENS = "tokens";

// Cafe24 설정
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || '2025-12-01';

// 전역 변수
let db;
let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

// ==========================================
// [2] MongoDB 연결 및 서버 시작 (여기가 유일한 시작점이어야 함)
// ==========================================
MongoClient.connect(MONGODB_URI)
    .then(client => {
        console.log(`✅ MongoDB Connected to [${DB_NAME}]`);
        db = client.db(DB_NAME);

        // 토큰 로드 후 서버 시작
        getTokensFromDB().then(() => {
            app.listen(PORT, () => {
                console.log(`🚀 Server running on port ${PORT}`);
            });
        });
    })
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err);
        // DB 연결 실패 시 서버를 켜지 않고 종료하거나 에러 처리
    });


// ==========================================
// [3] 토큰 관리 시스템
// ==========================================
async function getTokensFromDB() {
    try {
        const collection = db.collection(COLLECTION_TOKENS);
        const tokensDoc = await collection.findOne({});

        if (tokensDoc) {
            accessToken = tokensDoc.accessToken;
            refreshToken = tokensDoc.refreshToken;
            console.log('🔑 Token Loaded from DB');
        } else {
            console.log('⚠️ No tokens in DB. Using env vars.');
            if (accessToken && refreshToken) {
                await saveTokensToDB(accessToken, refreshToken);
            }
        }
    } catch (error) {
        console.error('❌ Token Load Error:', error);
    }
}

async function saveTokensToDB(newAccessToken, newRefreshToken) {
    try {
        const collection = db.collection(COLLECTION_TOKENS);
        await collection.updateOne(
            {},
            {
                $set: {
                    accessToken: newAccessToken,
                    refreshToken: newRefreshToken,
                    updatedAt: new Date(),
                },
            },
            { upsert: true }
        );
        console.log('💾 Tokens Saved to DB');
    } catch (error) {
        console.error('❌ Token Save Error:', error);
    }
}

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

        accessToken = newAccessToken;
        refreshToken = newRefreshToken;
        await saveTokensToDB(newAccessToken, newRefreshToken);
        console.log(`✅ Token Refreshed`);
        return newAccessToken;
    } catch (error) {
        console.error(`❌ Token Refresh Failed:`, error.message);
        throw error;
    }
}

async function apiRequest(method, url, data = {}, params = {}) {
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
        if (error.response && error.response.status === 401) {
            console.log(`⚠️ 401 Error. Refreshing token...`);
            await refreshAccessToken();
            return apiRequest(method, url, data, params);
        } else {
            throw error;
        }
    }
}

// ==========================================
// [4] API 라우트
// ==========================================

// 상품 검색
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;
        if (!keyword) return res.json({ success: true, count: 0, data: [] });

        console.log(`🔍 Searching: "${keyword}"`);

        const response = await apiRequest(
            'GET',
            `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`,
            null,
            {
                'shop_no': 1,
                'product_name': keyword,
                'display': 'T',
                'selling': 'T',
                'embed': 'options,images',
                'limit': 50
            }
        );

        const products = response.products || [];
        const cleanData = products.map(item => {
            let myOptions = [];
            let rawOptionList = [];

            if (item.options) {
                if (Array.isArray(item.options)) rawOptionList = item.options;
                else if (item.options.options && Array.isArray(item.options.options)) rawOptionList = item.options.options;
            }

            if (rawOptionList.length > 0) {
                let targetOption = rawOptionList.find(opt => {
                    const name = (opt.option_name || "").toLowerCase();
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

            let detailImage = item.detail_image || item.product_image || item.image_url || '';
            let listImage = item.list_image || '';
            let smallImage = item.small_image || '';

            if (item.images && Array.isArray(item.images) && item.images.length > 0) {
                const firstImage = item.images[0];
                if (!detailImage && firstImage.big) detailImage = firstImage.big;
                if (!listImage && firstImage.medium) listImage = firstImage.medium;
                if (!smallImage && firstImage.small) smallImage = firstImage.small;
            }

            return {
                product_no: item.product_no,
                product_name: item.product_name,
                price: Math.floor(Number(item.price)),
                options: myOptions,
                detail_image: detailImage,
                list_image: listImage,
                small_image: smallImage
            };
        });

        res.json({ success: true, count: cleanData.length, data: cleanData });
    } catch (error) {
        console.error('[Cafe24 API Error]:', error.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// 주문 저장
app.post('/api/ordersOffData', async (req, res) => {
    try {
        const collection = db.collection(COLLECTION_ORDERS);
        const {
            store_name, manager_name, customer_name, customer_phone, address,
            product_name, option_name, total_amount, shipping_cost, items, is_synced
        } = req.body;

        const orderItems = items && Array.isArray(items) ? items : [{
            product_name: product_name,
            option_name: option_name,
            price: 0,
            quantity: 1
        }];

        const newOrder = {
            store_name: store_name || '미지정',
            manager_name: manager_name || '미지정',
            customer_name,
            customer_phone,
            address: address || '',
            product_name,
            option_name,
            total_amount: Number(total_amount) || 0,
            shipping_cost: Number(shipping_cost) || 0,
            items: orderItems,
            is_synced: is_synced || false,
            created_at: new Date(),
            synced_at: null
        };

        const result = await collection.insertOne(newOrder);
        res.json({ success: true, message: 'Order Saved', orderId: result.insertedId });
    } catch (error) {
        console.error('Order Save Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 주문 조회
app.get('/api/ordersOffData', async (req, res) => {
    try {
        const collection = db.collection(COLLECTION_ORDERS);
        const { store_name, startDate, endDate, keyword } = req.query;
        let query = {};

        if (store_name && store_name !== '전체' && store_name !== 'null') query.store_name = store_name;
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

        const orders = await collection.find(query).sort({ created_at: -1 }).toArray();
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) {
        console.error('Order List Error:', error);
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// ERP 동기화
app.post('/api/ordersOffData/sync', async (req, res) => {
    try {
        const collection = db.collection(COLLECTION_ORDERS);
        const { orderIds } = req.body;
        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) return res.status(400).json({ success: false });

        const objectIds = orderIds.map(id => new ObjectId(id));
        const result = await collection.updateMany(
            { _id: { $in: objectIds } },
            { $set: { is_synced: true, synced_at: new Date() } }
        );
        res.json({ success: true, updatedCount: result.modifiedCount });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 주문 삭제
app.delete('/api/ordersOffData/:id', async (req, res) => {
    try {
        const collection = db.collection(COLLECTION_ORDERS);
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        const result = await collection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) res.json({ success: true });
        else res.status(404).json({ success: false });
    } catch (error) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// ★★★ 절대 맨 아래에 app.listen을 또 쓰지 마세요! ★★★ 
// 위쪽 MongoClient.connect 안에서 이미 서버를 켰습니다.