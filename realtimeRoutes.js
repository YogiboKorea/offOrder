// ==========================================
// 📦 realtime 서버에서 옮겨 온 오프라인 API (2026-10 클라우드타입 서버 통합)
//   원본: YogiboKorea/realTime web.js — 좌수왕·매니저·목표, 매장 게시판·근무통계·서포터즈·매장 링크,
//   오프라인 매출 조회, 재고 조회. 데이터는 예전 그대로 yogibo / off / yogibo_stock / warehouse DB에 있다.
//   옮기지 않은 것: OFForder 주문서 4개(이 서버의 /api/ordersOffData가 실제로 쓰임),
//   고장 난 Cafe24 상품 검색 2개(apiRequest 없음), 일회성 이름 통합 API(/api/admin/migrate-data)
// ==========================================
const express = require('express');
const { ObjectId } = require('mongodb');
const moment = require('moment-timezone');
const crypto = require('crypto');

const router = express.Router();

// realtime은 DB_NAME(기본 yogibo)을 썼다. 이 서버의 DB_NAME(OFFLINE_ORDER)과 섞이지 않게 이름을 따로 둔다
const REALTIME_DB_NAME = process.env.REALTIME_DB_NAME || 'yogibo';

let mongoClient; // index.js와 같은 연결
let db;          // yogibo DB

function init(client) {
    mongoClient = client;
    db = client.db(REALTIME_DB_NAME);
}

// ==========================================
// [설정] 컬렉션 이름 정의
// ==========================================
const jwasuCollectionName = 'offline_jwasu';      // [좌수] 일별 카운트 기록
const staffCollectionName = 'jwasu_managers';     // [관리] 오프라인 매니저 정보
const monthlyTargetCollection = 'jwasu_monthly_targets'; // [NEW] 월별 목표 관리
const managerSalesCollection = 'manager_salesNew';   // [NEW] 매니저별 매출 기록
const orderCollectionName = 'offline_orders';     // ★ [NEW] 오프라인 주문 내역 저장용 컬렉션

// ==========================================
// [API] 매장 목록 동적 조회 (중복 제거)
// ==========================================
router.get('/api/jwasu/stores', async (req, res) => {
    try {
        // 1. 매니저 정보가 있는 매장들
        const staffStores = await db.collection(staffCollectionName).distinct('storeName');
        
        // 2. 매출 데이터(이카운트)가 있는 매장들
        const salesStores = await db.collection(managerSalesCollection).distinct('storeName');

        // 3. 두 리스트 합치기 & 중복 제거 & 가나다순 정렬
        // (Set을 사용하면 중복이 자동으로 사라집니다)
        const allStores = [...new Set([...staffStores, ...salesStores])]
                          .filter(s => s && s.trim() !== '') // 빈 값 제외
                          .sort();

        res.json({ success: true, stores: allStores });
    } catch (error) {
        console.error('매장 목록 조회 실패:', error);
        res.status(500).json({ success: false, stores: [] });
    }
});

// ==========================================
// [섹션 C] 오프라인 좌수왕 API (카운트/대시보드)
// ==========================================

// [링크 접속용] 링크 ID로 매니저 정보 조회
router.get('/api/jwasu/link/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: '잘못된 링크입니다.' });

        const manager = await db.collection(staffCollectionName).findOne({ _id: new ObjectId(id) });
        
        if (!manager) {
            return res.json({ success: false, message: '매니저 정보를 찾을 수 없습니다.' });
        }

        if (manager.isActive === false) {
            return res.json({ success: false, message: '현재 비활성화된 링크입니다.', isInactive: true });
        }

        res.json({ success: true, storeName: manager.storeName, managerName: manager.managerName });
    } catch (error) {
        console.error('링크 조회 오류:', error);
        res.status(500).json({ success: false, message: '링크 조회 실패' });
    }
});

// 1. [POST] 좌수 카운트 증가
router.post('/api/jwasu/increment', async (req, res) => {
    try {
        const { storeName, managerName } = req.body || {};
        const mgrName = managerName || '미지정';

        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');
        const currentMonthStr = now.format('YYYY-MM');

        const collection = db.collection(jwasuCollectionName);
        const staffCollection = db.collection(staffCollectionName);
        const targetCollection = db.collection(monthlyTargetCollection);

        // 기본 정보 조회
        const staffInfo = await staffCollection.findOne({ storeName: storeName, managerName: mgrName });
        
        // 이번 달 설정된 목표 조회
        const monthlyTarget = await targetCollection.findOne({ month: currentMonthStr, storeName: storeName, managerName: mgrName });

        // 목표 결정
        const finalTargetCount = (monthlyTarget && monthlyTarget.targetCount > 0) ? monthlyTarget.targetCount : (staffInfo ? staffInfo.targetCount : 0);
        const finalMonthlySales = (monthlyTarget && monthlyTarget.targetMonthlySales > 0) ? monthlyTarget.targetMonthlySales : (staffInfo ? staffInfo.targetMonthlySales : 0);
        const finalWeeklySales = (monthlyTarget && monthlyTarget.targetWeeklySales) ? monthlyTarget.targetWeeklySales : (staffInfo ? staffInfo.targetWeeklySales : 0);

        const updateData = {
            $inc: { count: 1 },
            $set: { 
                lastUpdated: new Date(),
                role: staffInfo ? staffInfo.role : '매니저',
                consignment: staffInfo ? staffInfo.consignment : 'N',
                targetCount: finalTargetCount,
                targetMonthlySales: finalMonthlySales,
                targetWeeklySales: finalWeeklySales
            },
            $setOnInsert: { createdAt: new Date() }
        };

        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName, managerName: mgrName },
            updateData,
            { upsert: true, returnDocument: 'after' }
        );

        const updatedDoc = result.value || result; 
        const todayCount = updatedDoc.count;

        const pipeline = [
            { $match: { storeName: storeName, managerName: mgrName, date: { $gte: startOfMonth, $lte: todayStr } } },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ];
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : todayCount;

        res.json({ success: true, storeName, managerName: mgrName, todayCount, monthlyTotal });

    } catch (error) {
        console.error('좌수 증가 오류:', error);
        res.status(500).json({ success: false, message: '카운트 처리 중 오류 발생' });
    }
});

// 1-1. [POST] 좌수 수동 입력 추가 (한 번에 여러 개 추가) 중복입력지정
router.post('/api/jwasu/add', async (req, res) => {
    try {
        const { storeName, managerName, count } = req.body || {};
        const mgrName = managerName || '미지정';
        
        // 입력된 값이 숫자가 아니거나 0보다 작으면 에러 처리
        const addAmount = parseInt(count);
        if (isNaN(addAmount) || addAmount <= 0) {
            return res.status(400).json({ success: false, message: '유효한 숫자가 아닙니다.' });
        }

        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');
        const currentMonthStr = now.format('YYYY-MM');

        const collection = db.collection(jwasuCollectionName);
        const staffCollection = db.collection(staffCollectionName);
        const targetCollection = db.collection(monthlyTargetCollection);

        // --- (여기부터는 increment와 동일: 매니저 정보 및 목표 최신화) ---
        // 기본 정보 조회
        const staffInfo = await staffCollection.findOne({ storeName: storeName, managerName: mgrName });
        
        // 이번 달 설정된 목표 조회
        const monthlyTarget = await targetCollection.findOne({ month: currentMonthStr, storeName: storeName, managerName: mgrName });

        // 목표 결정 로직
        const finalTargetCount = (monthlyTarget && monthlyTarget.targetCount > 0) ? monthlyTarget.targetCount : (staffInfo ? staffInfo.targetCount : 0);
        const finalMonthlySales = (monthlyTarget && monthlyTarget.targetMonthlySales > 0) ? monthlyTarget.targetMonthlySales : (staffInfo ? staffInfo.targetMonthlySales : 0);
        const finalWeeklySales = (monthlyTarget && monthlyTarget.targetWeeklySales) ? monthlyTarget.targetWeeklySales : (staffInfo ? staffInfo.targetWeeklySales : 0);
        // ----------------------------------------------------------------

        const updateData = {
            $inc: { count: addAmount }, // ★ 핵심: 1이 아니라 받아온 숫자만큼 증가
            $set: { 
                lastUpdated: new Date(),
                role: staffInfo ? staffInfo.role : '매니저',
                consignment: staffInfo ? staffInfo.consignment : 'N',
                targetCount: finalTargetCount,
                targetMonthlySales: finalMonthlySales,
                targetWeeklySales: finalWeeklySales
            },
            $setOnInsert: { createdAt: new Date() }
        };

        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName, managerName: mgrName },
            updateData,
            { upsert: true, returnDocument: 'after' }
        );

        const updatedDoc = result.value || result; 
        const todayCount = updatedDoc.count;

        // 월 누적 다시 계산
        const pipeline = [
            { $match: { storeName: storeName, managerName: mgrName, date: { $gte: startOfMonth, $lte: todayStr } } },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ];
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : todayCount;

        res.json({ success: true, storeName, managerName: mgrName, todayCount, monthlyTotal });

    } catch (error) {
        console.error('좌수 수동 추가 오류:', error);
        res.status(500).json({ success: false, message: '추가 처리 중 오류 발생' });
    }
});

// ==========================================
// [보안] 암호화 설정 (매장 링크용)
// ==========================================
// 32글자 비밀키 (절대 외부에 노출 금지, 서버 재시작시 유지되게 고정값 사용)
const ENCRYPTION_KEY = '12345678901234567890123456789012'; // 32자여야 함
const IV_LENGTH = 16; // AES 블록 크기

function encrypt(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    try {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        return null; // 복호화 실패 시 null 반환
    }
}

// [API] 매장별 보안 링크 생성 (어드민용)
// 예: /api/jwasu/generate-link?storeName=스타필드고양
router.get('/api/jwasu/generate-link', (req, res) => {
    const { storeName } = req.query;
    if (!storeName) return res.status(400).json({ success: false });
    
    const token = encrypt(storeName);
    // 실제 서비스 URL에 맞게 수정하세요 (예: https://yoursite.com)
    const fullLink = `https://yogibo.kr/off/index.html?code=${token}`;
    
    res.json({ success: true, link: fullLink, token: token });
});

// [API] 보안 토큰 검증 (프론트엔드 접속용)
router.get('/api/jwasu/validate-link', (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ success: false });

    const storeName = decrypt(code);
    if (!storeName) {
        return res.status(400).json({ success: false, message: '유효하지 않은 링크입니다.' });
    }

    res.json({ success: true, storeName: storeName });
});


// [API] 전체 매장 보안 링크 리스트 반환 (어드민용)
router.get('/api/jwasu/admin/all-links', async (req, res) => {
    try {
        // [수정됨] salesColl -> db.collection(managerSalesCollection) 로 변경
        // managerSalesCollection은 맨 위에서 'manager_salesNew'로 정의되어 있습니다.
        const stores = await db.collection(managerSalesCollection).distinct("storeName"); 
        
        // 2. 매장명이 유효한 것만 필터링 (null, 빈값 제외)
        const validStores = stores.filter(s => s && s.trim() !== '');

        // 3. 각 매장별 암호화 링크 생성
        const linkList = validStores.map(store => {
            const token = encrypt(store);
            return {
                storeName: store,
                link: `https://yogibo.kr/off/index.html?code=${token}` // 실제 도메인
            };
        });

        // 가나다 순 정렬
        linkList.sort((a, b) => a.storeName.localeCompare(b.storeName));

        res.json({ success: true, list: linkList });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '매장 목록을 불러오지 못했습니다.' });
    }
});

// [섹션 I] 전년/전월 대비 데이터 조회 (수정됨: 로그 추가 및 날짜 계산 강화)
router.get('/api/jwasu/comparison', async (req, res) => {
    try {
        const { startDate, endDate, storeName, managerName, type } = req.query;
        
        // 필수 값 체크
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, message: '날짜 정보가 없습니다.' });
        }

        // 1. 비교 기준 설정 ('month' 아니면 무조건 'year')
        const compareType = type === 'month' ? 'month' : 'year';
        const subtractAmount = 1;

        // 2. 날짜 계산 (Moment.js 사용)
        // 현재 조회 중인 날짜
        const currentStartObj = moment(startDate);
        const currentEndObj = moment(endDate);

        // 과거(비교) 날짜 계산
        const lastStart = currentStartObj.clone().subtract(subtractAmount, compareType).format('YYYY-MM-DD');
        const lastEnd = currentEndObj.clone().subtract(subtractAmount, compareType).format('YYYY-MM-DD');

        // ★ [디버깅 로그] 서버 터미널에서 이 로그를 확인하세요!
        console.log(`📊 [비교 조회] 기준: ${compareType}`);
        console.log(`   - 현재: ${startDate} ~ ${endDate}`);
        console.log(`   - 과거: ${lastStart} ~ ${lastEnd}`);
        console.log(`   - 매장: ${storeName || '전체'}, 매니저: ${managerName || '전체'}`);

        // 3. 검색 조건 생성 (과거 날짜 기준)
        let matchQuery = { 
            date: { $gte: lastStart, $lte: lastEnd } 
        };

        // 매장 필터 (전체 아닐 때만)
        if (storeName && storeName !== 'all' && storeName !== 'null') {
            matchQuery.storeName = storeName;
        }
        
        // 매니저 검색
        if (managerName && managerName !== 'null') {
            matchQuery.managerName = { $regex: managerName, $options: 'i' };
        }

        // 4. 작년(또는 전월) 매출 합계 조회
        const salesColl = db.collection(managerSalesCollection);
        const salesResult = await salesColl.aggregate([
            { $match: matchQuery },
            { $group: { _id: null, total: { $sum: "$salesAmount" } } }
        ]).toArray();
        const lastYearRevenue = salesResult.length > 0 ? salesResult[0].total : 0;

        // 5. 작년(또는 전월) 좌수 합계 조회
        const jwasuColl = db.collection(jwasuCollectionName);
        const jwasuResult = await jwasuColl.aggregate([
            { $match: matchQuery },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ]).toArray();
        const lastYearCount = jwasuResult.length > 0 ? jwasuResult[0].total : 0;

        res.json({ 
            success: true, 
            lastYearRevenue, 
            lastYearCount,
            period: `${lastStart} ~ ${lastEnd}`,
            type: compareType
        });

    } catch (error) {
        console.error('❌ 비교 데이터 조회 오류:', error);
        res.status(500).json({ success: false });
    }
});

// 2. [POST] 좌수 카운트 취소
router.post('/api/jwasu/undo', async (req, res) => {
    try {
        const { storeName, managerName } = req.body || {};
        const mgrName = managerName || '미지정';

        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');
        const collection = db.collection(jwasuCollectionName);

        const currentDoc = await collection.findOne({ date: todayStr, storeName: storeName, managerName: mgrName });
        if (!currentDoc || currentDoc.count <= 0) {
            return res.status(400).json({ success: false, message: '취소할 내역이 없습니다.' });
        }

        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName, managerName: mgrName },
            { $inc: { count: -1 }, $set: { lastUpdated: new Date() } },
            { returnDocument: 'after' }
        );

        const pipeline = [
            { $match: { storeName: storeName, managerName: mgrName, date: { $gte: startOfMonth, $lte: todayStr } } },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ];
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : 0;
        const updatedDoc = result.value || result;

        res.json({ success: true, storeName, managerName: mgrName, todayCount: updatedDoc ? updatedDoc.count : 0, monthlyTotal });
    } catch (error) {
        console.error('취소 처리 오류:', error);
        res.status(500).json({ success: false, message: '취소 처리 중 오류 발생' });
    }
});

// 3. [GET] 대시보드 데이터 조회
router.get('/api/jwasu/dashboard', async (req, res) => {
    try {
        const queryDate = req.query.date;
        const targetEndDate = queryDate ? queryDate : moment().tz('Asia/Seoul').format('YYYY-MM-DD');
        const targetStartDate = moment(targetEndDate).startOf('month').format('YYYY-MM-DD');
        const targetMonthStr = moment(targetEndDate).format('YYYY-MM');
        
        const collection = db.collection(jwasuCollectionName);
        const staffCollection = db.collection(staffCollectionName);
        const targetCollection = db.collection(monthlyTargetCollection);

        const normalize = (str) => String(str || '').replace(/\s+/g, '').trim();

        const allStaffs = await staffCollection.find().toArray();
        const staffMap = {};
        const nameMap = {};
        const activeSet = new Set();

        allStaffs.forEach(s => {
            const normName = normalize(s.managerName);
            const key = `${normalize(s.storeName)}_${normName}`;
            
            staffMap[key] = s;
            nameMap[normName] = s;
            
            if (s.isActive !== false) activeSet.add(key);
        });

        const monthlyTargets = await targetCollection.find({ month: targetMonthStr }).toArray();
        const monthlyTargetMap = {};
        monthlyTargets.forEach(t => {
            const key = `${normalize(t.storeName)}_${normalize(t.managerName)}`;
            monthlyTargetMap[key] = t;
        });

        const records = await collection.find({ 
            date: { $gte: targetStartDate, $lte: targetEndDate } 
        }).toArray();

        const aggregates = {};
        
        records.forEach(record => {
            const mgr = record.managerName || '미지정';
            const normName = normalize(mgr);
            const normStore = normalize(record.storeName);
            
            let uniqueKey = `${normStore}_${normName}`;
            let info = staffMap[uniqueKey];

            if (!info) {
                const found = nameMap[normName];
                if (found) {
                    info = found;
                    uniqueKey = `${normalize(found.storeName)}_${normName}`;
                }
            }

            const mTarget = monthlyTargetMap[uniqueKey];

            let finalTarget = 0;
            let finalSales = 0;
            let finalWeekly = { w1:0, w2:0, w3:0, w4:0, w5:0 };
            let joinDate = null;

            if (mTarget && mTarget.targetCount > 0) finalTarget = mTarget.targetCount;
            else if (record.targetCount > 0) finalTarget = record.targetCount;
            else if (info) finalTarget = info.targetCount;

            if (mTarget && mTarget.targetMonthlySales > 0) finalSales = mTarget.targetMonthlySales;
            else if (record.targetMonthlySales > 0) finalSales = record.targetMonthlySales;
            else if (info) finalSales = info.targetMonthlySales;

            if (mTarget && mTarget.targetWeeklySales) finalWeekly = mTarget.targetWeeklySales;
            else if (record.targetWeeklySales) finalWeekly = record.targetWeeklySales;
            else if (info && info.targetWeeklySales) finalWeekly = info.targetWeeklySales;

            if (mTarget && mTarget.joinDate) joinDate = mTarget.joinDate;
            else if (info && info.joinDate) joinDate = info.joinDate;

            if (!aggregates[uniqueKey]) {
                aggregates[uniqueKey] = { 
                    storeName: info ? info.storeName : record.storeName,
                    managerName: mgr,
                    role: record.role || (info ? info.role : '-'),
                    targetCount: finalTarget, 
                    targetMonthlySales: finalSales,
                    targetWeeklySales: finalWeekly, 
                    joinDate: joinDate, 
                    count: 0, 
                    rank: 0,
                    rate: 0
                };
            } else {
                if (aggregates[uniqueKey].targetCount === 0 && finalTarget > 0) aggregates[uniqueKey].targetCount = finalTarget;
                if (aggregates[uniqueKey].targetMonthlySales === 0 && finalSales > 0) aggregates[uniqueKey].targetMonthlySales = finalSales;
                
                const currW = aggregates[uniqueKey].targetWeeklySales;
                if ((!currW || (currW.w1===0 && currW.w2===0)) && (finalWeekly.w1>0 || finalWeekly.w2>0)) {
                    aggregates[uniqueKey].targetWeeklySales = finalWeekly;
                }
                if (!aggregates[uniqueKey].joinDate && joinDate) {
                    aggregates[uniqueKey].joinDate = joinDate;
                }
            }
            
            aggregates[uniqueKey].count += record.count;
        });

        activeSet.forEach(key => {
            if (!aggregates[key]) {
                const info = staffMap[key];
                const mTarget = monthlyTargetMap[key];
                
                const finalTarget = (mTarget && mTarget.targetCount > 0) ? mTarget.targetCount : (info.targetCount || 0);
                const finalSales = (mTarget && mTarget.targetMonthlySales > 0) ? mTarget.targetMonthlySales : (info.targetMonthlySales || 0);
                const finalWeekly = (mTarget && mTarget.targetWeeklySales) ? mTarget.targetWeeklySales : (info.targetWeeklySales || { w1:0, w2:0, w3:0, w4:0, w5:0 });
                
                let joinDate = null;
                if (mTarget && mTarget.joinDate) joinDate = mTarget.joinDate;
                else if (info && info.joinDate) joinDate = info.joinDate;

                aggregates[key] = {
                    storeName: info.storeName,
                    managerName: info.managerName,
                    role: info.role || '-',
                    targetCount: finalTarget,
                    targetMonthlySales: finalSales,
                    targetWeeklySales: finalWeekly, 
                    joinDate: joinDate, 
                    count: 0,
                    rank: 0,
                    rate: 0
                };
            }
        });

        const dashboardData = Object.values(aggregates);

        dashboardData.forEach(item => {
            if (item.targetCount > 0) {
                item.rate = parseFloat(((item.count / item.targetCount) * 100).toFixed(1));
            } else {
                item.rate = 0;
            }
        });

        dashboardData.sort((a, b) => {
            if (b.rate !== a.rate) return b.rate - a.rate;
            return b.count - a.count;
        });

        dashboardData.forEach((item, index) => { item.rank = index + 1; });
        const totalCount = dashboardData.reduce((acc, cur) => acc + cur.count, 0);

        res.json({ success: true, startDate: targetStartDate, endDate: targetEndDate, totalCount, data: dashboardData });

    } catch (error) {
        console.error('대시보드 조회 오류:', error);
        res.status(500).json({ success: false, message: '대시보드 데이터 조회 오류' });
    }
});

// [섹션 - 통합 조회] 테이블 API
router.get('/api/jwasu/table', async (req, res) => {
    try {
        const { store, startDate, endDate } = req.query;
        let query = {};
        
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        }
        
        if (store && store !== 'all') {
            query.storeName = store; 
        }

        const jwasuList = await db.collection(jwasuCollectionName)
                                  .find(query)
                                  .sort({ date: -1 })
                                  .toArray();

        const report = jwasuList.map(item => ({
            type: 'jwasu',
            date: item.date,
            storeName: item.storeName || '알수없음',
            managerName: item.managerName || '미지정',
            role: item.role || '-',
            count: item.count || 0,
            revenue: 0 
        }));
        
        res.status(200).json({ success: true, report: report });

    } catch (error) {
        console.error("좌수 테이블 조회 오류:", error);
        res.status(500).json({ success: false, message: '서버 내부 오류' });
    }
});

// ==========================================
// [섹션 G] 월별 목표 관리 API
// ==========================================

router.get('/api/jwasu/admin/monthly-target', async (req, res) => {
    try {
        const { month, storeName, managerName } = req.query;
        if (!month || !storeName || !managerName) return res.status(400).json({ success: false });

        const target = await db.collection(monthlyTargetCollection).findOne({ month, storeName, managerName });
        res.json({ success: true, data: target || {} });
    } catch (error) { res.status(500).json({ success: false }); }
});
router.post('/api/jwasu/admin/monthly-target', async (req, res) => {
    try {
        const { 
            month, storeName, managerName, 
            targetCount, targetMonthlySales, targetWeeklySales, 
            w1, w2, w3, w4, w5, w6, 
            joinDate 
        } = req.body || {};
        
        let weeklySalesData = { w1: 0, w2: 0, w3: 0, w4: 0, w5: 0, w6: 0 };

        if (targetWeeklySales && typeof targetWeeklySales === 'object') {
            weeklySalesData.w1 = parseInt(targetWeeklySales.w1) || 0;
            weeklySalesData.w2 = parseInt(targetWeeklySales.w2) || 0;
            weeklySalesData.w3 = parseInt(targetWeeklySales.w3) || 0;
            weeklySalesData.w4 = parseInt(targetWeeklySales.w4) || 0;
            weeklySalesData.w5 = parseInt(targetWeeklySales.w5) || 0;
            weeklySalesData.w6 = parseInt(targetWeeklySales.w6) || 0;
        } else {
            weeklySalesData.w1 = parseInt(w1) || 0;
            weeklySalesData.w2 = parseInt(w2) || 0;
            weeklySalesData.w3 = parseInt(w3) || 0;
            weeklySalesData.w4 = parseInt(w4) || 0;
            weeklySalesData.w5 = parseInt(w5) || 0;
            weeklySalesData.w6 = parseInt(w6) || 0;
        }

        // 1. 월별 목표 컬렉션에 저장 (기존 로직 유지)
        await db.collection(monthlyTargetCollection).updateOne(
            { month, storeName, managerName },
            { 
                $set: { 
                    targetCount: parseInt(targetCount) || 0,
                    targetMonthlySales: parseInt(targetMonthlySales) || 0,
                    targetWeeklySales: weeklySalesData,
                    joinDate: joinDate || null, 
                    updatedAt: new Date()
                } 
            },
            { upsert: true }
        );

        // ★ 2. [추가] 매니저 마스터 컬렉션에도 입사일 동기화 (영구 보존)
        if (joinDate) {
            await db.collection(staffCollectionName).updateOne(
                { storeName, managerName },
                { $set: { joinDate: joinDate, updatedAt: new Date() } }
            );
        }

        res.json({ success: true });
    } catch (error) { 
        console.error("목표 저장 오류:", error);
        res.status(500).json({ success: false }); 
    }
});

// [수정] 매니저 목록 조회 (시스템용 더미 데이터 숨김 처리)
router.get('/api/jwasu/admin/managers', async (req, res) => {
    try {
        // isHidden이 true가 아닌 것만 가져오기
        const managers = await db.collection(staffCollectionName)
                                 .find({ isHidden: { $ne: true } }) 
                                 .sort({ storeName: 1, managerName: 1 })
                                 .toArray();
        res.json({ success: true, managers });
    } catch (error) { res.status(500).json({ success: false }); }
});
// [추가] 매장만 단독 등록 (플레이스홀더 생성)
router.post('/api/jwasu/admin/store', async (req, res) => {
    try {
        const { storeName } = req.body || {};
        if (!storeName) return res.status(400).json({ success: false, message: '매장명이 필요합니다.' });

        // 이미 해당 매장명이 존재하는지 체크 (매니저가 있든, 더미가 있든)
        const exists = await db.collection(staffCollectionName).findOne({ storeName: storeName });
        if (exists) {
            return res.status(400).json({ success: false, message: '이미 존재하는 매장입니다.' });
        }

        // 매장 유지를 위한 '투명 인간(Placeholder)' 생성
        await db.collection(staffCollectionName).insertOne({
            storeName: storeName,
            managerName: "system_store_placeholder", // 식별용 이름
            role: "system",
            isHidden: true,  // ★ 매니저 목록에서 안 보이게 숨김 처리
            isActive: false, // 비활성화
            createdAt: new Date()
        });

        res.json({ success: true, message: '매장이 등록되었습니다.' });
    } catch (error) {
        console.error("매장 등록 오류:", error);
        res.status(500).json({ success: false, message: '서버 오류' });
    }
});
router.post('/api/jwasu/admin/manager', async (req, res) => {
    try {
        const { storeName, managerName, role, consignment, targetCount, targetMonthlySales, targetWeeklySales, isActive } = req.body || {};
        if (!storeName || !managerName) return res.status(400).json({ success: false });
        
        const checkRole = role || '';

        const exists = await db.collection(staffCollectionName).findOne({ 
            storeName, 
            managerName,
            role: checkRole
        });
        
        if (exists) return res.status(400).json({ success: false, message: '이미 등록된 매니저입니다 (동일 매장/이름/직급).' });

        await db.collection(staffCollectionName).insertOne({
            storeName, 
            managerName, 
            role: role || '매니저', 
            consignment: consignment || 'N',
            targetCount: parseInt(targetCount) || 0,
            targetMonthlySales: parseInt(targetMonthlySales) || 0,
            targetWeeklySales: parseInt(targetWeeklySales) || 0,
            isActive: isActive !== undefined ? isActive : true,
            createdAt: new Date()
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.put('/api/jwasu/admin/manager/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            storeName, managerName, role, consignment,
            targetCount, targetMonthlySales, targetWeeklySales,
            memo, joinDate, resignDate // ★ joinDate·resignDate 추가
        } = req.body || {};

        // 동적으로 업데이트할 필드 구성
        let updateFields = {
            storeName, managerName, role, consignment,
            targetCount: parseInt(targetCount) || 0,
            targetMonthlySales: parseInt(targetMonthlySales) || 0,
            // ★ 객체(주간목표 {w1..w6})면 그대로 보존, 아니면 숫자 처리 (객체를 0으로 덮어쓰던 문제 방지)
            targetWeeklySales: (targetWeeklySales && typeof targetWeeklySales === 'object') ? targetWeeklySales : (parseInt(targetWeeklySales) || 0),
            memo: memo,
            updatedAt: new Date()
        };

        // joinDate가 넘어왔을 때만 업데이트 필드에 포함
        if (joinDate !== undefined) {
            updateFields.joinDate = joinDate;
        }
        // ★ resignDate(퇴사일)가 넘어왔을 때만 업데이트 필드에 포함
        if (resignDate !== undefined) {
            updateFields.resignDate = resignDate;
        }

        await db.collection(staffCollectionName).updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields }
        );
        res.json({ success: true });
    } catch (error) { 
        console.error("매니저 수정 오류:", error);
        res.status(500).json({ success: false }); 
    }
});
router.put('/api/jwasu/admin/manager/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body || {}; 
        await db.collection(staffCollectionName).updateOne({ _id: new ObjectId(id) }, { $set: { isActive: isActive } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

router.delete('/api/jwasu/admin/manager/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "유효하지 않은 ID입니다." });
        }
        const result = await db.collection(staffCollectionName).deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 1) {
            res.json({ success: true, message: "삭제되었습니다." });
        } else {
            res.status(404).json({ success: false, message: "해당 매니저를 찾을 수 없습니다." });
        }
    } catch (error) {
        console.error("삭제 오류:", error);
        res.status(500).json({ success: false, message: "서버 오류로 삭제 실패" });
    }
});

// [섹션 - 기타 통계] - my-stats
router.get('/api/jwasu/my-stats', async (req, res) => {
    try {
        const { storeName, managerName } = req.query;
        if (!storeName) return res.status(400).json({ success: false });

        const now = moment().tz('Asia/Seoul');
        const startOfThisMonth = now.clone().startOf('month').format('YYYY-MM-DD');
        const endOfThisMonth = now.clone().endOf('month').format('YYYY-MM-DD');
        
        const collection = db.collection(jwasuCollectionName);
        
        const query = { storeName: storeName, date: { $gte: startOfThisMonth, $lte: endOfThisMonth } };
        if (managerName) query.managerName = managerName;
        
        const dailyRecords = await collection.find(query).sort({ date: -1 }).toArray();
        res.json({ success: true, data: dailyRecords });
    } catch (error) { res.status(500).json({ success: false }); }
});

// [섹션 - 월별 히스토리] - monthly-history
router.get('/api/jwasu/monthly-history', async (req, res) => {
    try {
        const { month } = req.query;
        if (!month) return res.status(400).json({ success: false });
        
        const startOfMonth = moment(month).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = moment(month).endOf('month').format('YYYY-MM-DD');
        
        const collection = db.collection(jwasuCollectionName);
        const pipeline = [ 
            { $match: { date: { $gte: startOfMonth, $lte: endOfMonth } } }, 
            { $group: { _id: { store: "$storeName", manager: "$managerName" }, totalCount: { $sum: "$count" } } } 
        ];
        
        const aggResults = await collection.aggregate(pipeline).toArray();
        const historyData = aggResults.map(item => ({ 
            storeName: item._id.store, 
            managerName: item._id.manager || '미지정', 
            count: item.totalCount, 
            rank: 0 
        }));
        
        historyData.sort((a, b) => b.count - a.count);
        historyData.forEach((item, index) => item.rank = index + 1);
        
        res.json(historyData);
    } catch (error) { res.status(500).json({ success: false }); }
});

// [섹션 F] 기존 좌수 엑셀 업로드 ★ 수정: 해당 날짜 데이터만 삭제 후 재등록
router.post('/api/jwasu/upload-excel', async (req, res) => {
         try {
          const { data } = req.body || {}; 
          if (!Array.isArray(data) || data.length === 0) return res.status(400).json({ success: false, message: '데이터가 없습니다.' });
         
          const jwasuCollection = db.collection(jwasuCollectionName);
          const staffCollection = db.collection(staffCollectionName);
          const allStaffs = await staffCollection.find().toArray();
          // 🆕 매장+성명 매칭 (동명이인 오배치 방지). 예전엔 성명만으로 키를 잡아 동명이인이 뭉쳤음
          const normKey = (str) => String(str || '').replace(/\s+/g, '').trim();
          const sortKey = (str) => normKey(str).split('').sort().join(''); // 어순 무시: "대구 롯데" ↔ "롯데대구"
          const staffByStoreName = {}; // 정규화매장_성명 -> staff (정확 일치)
          const staffBySortStore = {}; // 어순무시매장_성명 -> staff
          const nameCount = {};        // 성명 -> 등록 인원수 (동명이인 판별)
          const staffByNameOnly = {};  // 성명 -> staff (이름이 유일할 때만 폴백)
          allStaffs.forEach(s => {
            if (!s.managerName) return;
            const nName = normKey(s.managerName);
            staffByStoreName[`${normKey(s.storeName)}_${nName}`] = s;
            staffBySortStore[`${sortKey(s.storeName)}_${nName}`] = s;
            nameCount[nName] = (nameCount[nName] || 0) + 1;
            staffByNameOnly[nName] = s;
          });
        
         // ★★★ [수정] 업로드 데이터에서 '정확한 날짜(YYYY-MM-DD)'만 쏙쏙 뽑아내기 ★★★
         const dateSet = new Set();
         data.forEach(item => {
          if (item.date) {
            dateSet.add(item.date); // 예: "2025-01-05" 통째로 저장
          }
         });

         // ★★★ [수정] 월 전체가 아닌, 엑셀에 있는 '해당 날짜'의 기존 데이터만 삭제 ★★★
         const uniqueDates = [...dateSet];
         if (uniqueDates.length > 0) {
          // 🆕 [안전장치] 삭제 대상 = 이 날짜의 기존 전체. 삭제 전 자동 백업(부분파일 업로드 사고 복구용)
          const toBackup = await jwasuCollection.find({ date: { $in: uniqueDates } }).toArray();
          if (toBackup.length > 0) {
            const batchId = new Date().toISOString();
            const incomingPeople = [...new Set(data.map(x => String(x.managerName || '').trim()))].filter(Boolean);
            const existingPeople = [...new Set(toBackup.map(d => d.managerName))];
            // 부분파일 경고: 기존 인원보다 업로드 인원이 훨씬 적으면 (그 날짜 다른 직원이 삭제됨)
            if (existingPeople.length >= 5 && incomingPeople.length < existingPeople.length * 0.6) {
              console.warn(`[엑셀 업로드][⚠주의] 부분파일 의심 — 기존 ${existingPeople.length}명 / 업로드 ${incomingPeople.length}명. 나머지 직원의 해당 날짜 데이터가 삭제됩니다. (백업 batch ${batchId})`);
            }
            const backupDocs = toBackup.map(d => {
              const c = { ...d }; delete c._id;
              c._origId = d._id; c._backupAt = new Date(); c._backupBatch = batchId;
              c._backupReason = 'upload-excel-overwrite'; c._backupDates = uniqueDates;
              c._incomingPeopleCount = incomingPeople.length;
              return c;
            });
            await db.collection('offline_jwasu_backup').insertMany(backupDocs);
            console.log(`[엑셀 업로드] 삭제 전 자동 백업: ${backupDocs.length}건 저장 (batch ${batchId})`);
          }
          const deleteResult = await jwasuCollection.deleteMany({ date: { $in: uniqueDates } });
          console.log(`[엑셀 업로드] 기존 데이터 삭제: ${deleteResult.deletedCount}건 (대상 날짜: ${uniqueDates.join(', ')})`);
         }

          // 이후 bulkWrite로 새 데이터 삽입
          const dailyOperations = [];
          const managerUpdates = new Map();

         data.forEach(item => {
             let excelStore = String(item.storeName || '').trim();
             let excelName = String(item.managerName || '미지정').trim();
             const dateStr = item.date;
             const count = parseInt(item.count) || 0;
             const target = parseInt(item.target) || 0;
    
             const nName = normKey(excelName);
             // 1) 매장+성명 정확 일치 → 2) 어순 무시 매장+성명 일치
             let staffInfo = staffByStoreName[`${normKey(excelStore)}_${nName}`]
                          || staffBySortStore[`${sortKey(excelStore)}_${nName}`];
             // 3) 매장 매칭 실패 시: 성명이 유일하면 이름만으로 폴백 허용(동명이인은 폴백 금지 → 오배치 방지)
             if (!staffInfo && nameCount[nName] === 1) {
                 staffInfo = staffByNameOnly[nName];
             }
             if (!staffInfo && nameCount[nName] > 1) {
                 console.warn(`[좌수 업로드] 동명이인 매장 매칭 실패 → 엑셀 매장명 유지: ${excelStore} / ${excelName}`);
             }

             const finalStoreName = staffInfo ? staffInfo.storeName : excelStore;
             const finalManagerName = staffInfo ? staffInfo.managerName : excelName;
            
             dailyOperations.push({
              updateOne: {
               filter: { date: dateStr, storeName: finalStoreName, managerName: finalManagerName },
               update: {
               $set: {
                 count: count,
                 lastUpdated: new Date(),
                 role: staffInfo ? staffInfo.role : '매니저',
                 consignment: staffInfo ? staffInfo.consignment : 'N',
                 targetCount: target > 0 ? target : (staffInfo ? staffInfo.targetCount : 0),
                 targetMonthlySales: staffInfo ? (staffInfo.targetMonthlySales || 0) : 0,
                 targetWeeklySales: staffInfo ? (staffInfo.targetWeeklySales || 0) : 0
               },
               $setOnInsert: { createdAt: new Date() }
              },
              upsert: true
              }
             });

           if (target > 0 && staffInfo) {
           managerUpdates.set(staffInfo._id.toString(), target);
           }
          });

          if (dailyOperations.length > 0) {
           await jwasuCollection.bulkWrite(dailyOperations);
          }
         
          if (managerUpdates.size > 0) {
              const mgrOps = [];
              managerUpdates.forEach((newTarget, mgrId) => {
               mgrOps.push({
                updateOne: {
                 filter: { _id: new ObjectId(mgrId) },
                 update: { $set: { targetCount: newTarget } }
                }
               });
              });
              await staffCollection.bulkWrite(mgrOps);
             }

        // 완료 메시지도 날짜 기준으로 변경
        const dateDisplay = uniqueDates.length > 3 
                 ? `${uniqueDates.slice(0, 3).join(', ')} 외 ${uniqueDates.length - 3}일` 
                 : uniqueDates.join(', ');

         res.json({ success: true, message: `[${dateDisplay}] 기존 실적 덮어쓰기 완료. 총 ${dailyOperations.length}건 등록` });
         } catch (error) { 
          console.error('엑셀 업로드 오류:', error);
          res.status(500).json({ success: false, message: '업로드 중 서버 오류 발생' }); 
         }
    });

// [섹션 H] 매니저 매출 관리
router.get('/api/manager-sales', async (req, res) => {
    try {
        const { date, storeName } = req.query; 
        const query = {};
        
        if (date) query.date = date; 
        if (storeName) query.storeName = storeName;

        const collection = db.collection(managerSalesCollection);
        const results = await collection.find(query).sort({ date: -1, storeName: 1 }).toArray();

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('매니저 매출 조회 오류:', error);
        res.status(500).json({ success: false, message: '매출 데이터 조회 실패' });
    }
});

router.post('/api/manager-sales/upload-excel', async (req, res) => {
    try {
        const { data } = req.body || {}; 
        
        if (!Array.isArray(data) || data.length === 0) {
            return res.status(400).json({ success: false, message: '데이터가 없습니다.' });
        }

        const collection = db.collection(managerSalesCollection);
        const bulkOps = [];

        data.forEach(item => {
            const dateStr = item.date; 
            const storeName = String(item.storeName || '').trim();
            const managerName = String(item.managerName || '미지정').trim();
            const salesAmount = parseInt(item.salesAmount) || 0; 
            
            if (dateStr && storeName) {
                bulkOps.push({
                    updateOne: {
                        filter: { date: dateStr, storeName: storeName, managerName: managerName },
                        update: {
                            $set: {
                                salesAmount: salesAmount,
                                revenue: salesAmount,
                                type: 'sales',
                                lastUpdated: new Date()
                            },
                            $setOnInsert: { 
                                createdAt: new Date(),
                                count: 0,
                                role: ''
                            }
                        },
                        upsert: true 
                    }
                });
            }
        });

        if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps);
        }

        res.json({ success: true, message: `총 ${bulkOps.length}건의 매출 데이터 처리 완료` });

    } catch (error) {
        console.error('매니저 매출 엑셀 업로드 오류:', error);
        res.status(500).json({ success: false, message: '매출 업로드 중 오류 발생' });
    }
});


// 1. 조회 (GET): 기존 데이터가 있으면 가져오고, 없으면 빈 값 반환
router.get('/api/jwasu/admin/store-target', async (req, res) => {
    try {
        const { month, storeName } = req.query;
        if (!month || !storeName) return res.status(400).json({ success: false });

        // [1순위] '매장 공통 설정값(system_store_placeholder)'이 있는지 확인 (가장 정확함)
        let target = await db.collection(monthlyTargetCollection).findOne({
            month: month, 
            storeName: storeName, 
            managerName: "system_store_placeholder"
        });

        // [2순위 - 백업] 공통 설정값이 없다면? -> 옛날에 직원 이름으로 저장된 데이터 중 아무거나 하나 가져옴
        // 조건: 해당 월, 해당 매장의 데이터이면서, '시스템 플레이스홀더'가 아닌 것 중 가장 최근에 수정된 것
        if (!target) {
            const backupTargets = await db.collection(monthlyTargetCollection)
                .find({
                    month: month, 
                    storeName: storeName,
                    managerName: { $ne: "system_store_placeholder" } // 시스템 데이터 제외
                })
                .sort({ updatedAt: -1, _id: -1 }) // 가장 최근에 수정한거 우선
                .limit(1)
                .toArray();
            
            if (backupTargets.length > 0) {
                target = backupTargets[0];
            }
        }

        // 데이터가 없으면 빈 객체 반환, 있으면 데이터 반환
        res.json({ success: true, data: target || {} });

    } catch (error) {
        console.error("매장 목표 조회 오류:", error);
        res.status(500).json({ success: false });
    }
});

// [추가] 특정 월의 '모든 매장' 목표(placeholder) 일괄 조회
//   - 주간보고 등에서 권위 매장목표를 한 번에 받아 대시보드 매니저행 오염을 덮어쓰기 위함
router.get('/api/jwasu/admin/store-targets', async (req, res) => {
    try {
        const { month } = req.query;
        if (!month) return res.status(400).json({ success: false, message: 'month 필요' });
        const docs = await db.collection(monthlyTargetCollection)
            .find({ month: month, managerName: 'system_store_placeholder' })
            .toArray();
        const stores = docs.map(d => ({
            storeName: d.storeName,
            targetMonthlySales: d.targetMonthlySales || 0,
            targetWeeklySales: d.targetWeeklySales || {}
        }));
        res.json({ success: true, stores });
    } catch (error) {
        console.error('전체 매장목표 조회 오류:', error);
        res.status(500).json({ success: false, stores: [] });
    }
});

// 2. 저장 (POST): 이게 있어야 새로고침해도 데이터가 유지됩니다!
router.post('/api/jwasu/admin/store-target', async (req, res) => {
    try {
        const { month, storeName, targetMonthlySales, targetWeeklySales } = req.body || {};

        if (!month || !storeName) return res.status(400).json({ success: false, message: '정보가 부족합니다.' });

        const monthlySales = parseInt(targetMonthlySales) || 0;
        // ★ w6: 0 초기값 추가
        let weeklyData = { w1: 0, w2: 0, w3: 0, w4: 0, w5: 0, w6: 0 };
        
        if (targetWeeklySales) {
            weeklyData.w1 = parseInt(targetWeeklySales.w1) || 0;
            weeklyData.w2 = parseInt(targetWeeklySales.w2) || 0;
            weeklyData.w3 = parseInt(targetWeeklySales.w3) || 0;
            weeklyData.w4 = parseInt(targetWeeklySales.w4) || 0;
            weeklyData.w5 = parseInt(targetWeeklySales.w5) || 0;
            weeklyData.w6 = parseInt(targetWeeklySales.w6) || 0; // ★ 추가
        }

        // [A] 매장 공통 데이터
        await db.collection(monthlyTargetCollection).updateOne(
            { month: month, storeName: storeName, managerName: "system_store_placeholder" },
            { 
                $set: { 
                    targetMonthlySales: monthlySales,
                    targetWeeklySales: weeklyData,
                    updatedAt: new Date()
                } 
            },
            { upsert: true }
        );

        // [B] 해당 매장의 모든 직원들 데이터도 일괄 업데이트
        await db.collection(monthlyTargetCollection).updateMany(
            { month: month, storeName: storeName, managerName: { $ne: "system_store_placeholder" } },
            { 
                $set: { 
                    targetMonthlySales: monthlySales,
                    targetWeeklySales: weeklyData,
                    updatedAt: new Date()
                } 
            }
        );

        // [C] 매니저 기본 정보
        await db.collection(staffCollectionName).updateMany(
            { storeName: storeName },
            { 
                $set: { 
                    targetMonthlySales: monthlySales,
                    targetWeeklySales: weeklyData
                } 
            }
        );

        res.json({ success: true, message: '저장되었습니다.' });

    } catch (error) {
        console.error("매장 목표 저장 오류:", error);
        res.status(500).json({ success: false, message: '서버 오류' });
    }
});

// ==========================================
// [추가] 매장명 일괄 수정 및 삭제 API
// ==========================================

// 1. 매장명 일괄 변경 (Renaming)
// 기존 매장명(oldName)을 가진 모든 매니저의 storeName을 newName으로 변경
router.put('/api/jwasu/admin/store/rename', async (req, res) => {
    try {
        const { oldName, newName } = req.body || {};
        if (!oldName || !newName) return res.status(400).json({ success: false, message: '매장명이 필요합니다.' });

        // jwasu_managers 컬렉션 업데이트
        const result = await db.collection(staffCollectionName).updateMany(
            { storeName: oldName },
            { $set: { storeName: newName, lastUpdated: new Date() } }
        );

        // 좌수 기록·월별 목표도 같이 옮긴다.
        // 안 옮기면 그 매장의 좌수와 목표가 옛 이름에 남아 Y리그·주간보고에서 통째로 빠진다.
        const jwasuRes = await db.collection(jwasuCollectionName).updateMany(
            { storeName: oldName },
            { $set: { storeName: newName } }
        );
        const targetRes = await db.collection(monthlyTargetCollection).updateMany(
            { storeName: oldName },
            { $set: { storeName: newName } }
        );

        // 매출(manager_salesNew)은 손대지 않는다 — 이카운트에서 내려오는 매장명이라
        // 여기서 바꿔도 다음 동기화 때 옛 이름으로 되돌아온다. 이카운트 매장명은 코드 관리에서 맞춘다.

        res.json({
            success: true,
            message: `매장명이 변경되었습니다. (직원 ${result.modifiedCount}건, 좌수 ${jwasuRes.modifiedCount}건, 목표 ${targetRes.modifiedCount}건)`,
            moved: { managers: result.modifiedCount, jwasu: jwasuRes.modifiedCount, targets: targetRes.modifiedCount }
        });
    } catch (error) {
        console.error('매장명 변경 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류 발생' });
    }
});

// 2. 매장 일괄 삭제 (Delete All Managers in Store)
// 해당 매장에 속한 매니저를 전부 삭제합니다.
router.delete('/api/jwasu/admin/store', async (req, res) => {
    try {
        const { storeName } = req.body || {}; // DELETE는 body 사용 시 주의, 혹은 query로 받아도 됨. 여기선 body 사용
        if (!storeName) return res.status(400).json({ success: false, message: '매장명이 필요합니다.' });

        const result = await db.collection(staffCollectionName).deleteMany({ storeName: storeName });

        res.json({ success: true, message: `${storeName} 소속 매니저 ${result.deletedCount}명이 삭제되었습니다.` });
    } catch (error) {
        console.error('매장 삭제 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류 발생' });
    }
});

// ==========================================
// ★ [추가] 오프라인 전용 API (OFF DB 사용)
// 게시판, 근무시간, 서포터, 매장링크 관리
// ==========================================

// 0. [필수] 월(Month) 목록 조회 API (필터용) -> 이게 있어야 드롭다운이 나옴
router.get('/api/months', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        // 'orders' 컬렉션에 있는 모든 month 값을 중복 없이 가져옴
        const months = await dbOff.collection('orders').distinct('month');
        // 내림차순 정렬 (최신순)
        months.sort().reverse();
        res.json({ success: true, months });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, months: [] });
    }
});

// ------------------------------------------
// 1. 게시판 (Messages) API
// ------------------------------------------
const messageCollectionName = 'messages'; 

// 게시글 목록 조회
router.get('/api/messages', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off'); // ★ off DB 사용
        const collection = dbOff.collection(messageCollectionName);
        
        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        const result = messages.map(m => ({ ...m, id: m._id }));
        res.json({ success: true, messages: result });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '게시글 조회 실패' });
    }
});

// 게시글 작성
router.post('/api/messages', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection(messageCollectionName);
        const { store, week, manager, title, content, isGlobal, isStoreNotice } = req.body || {};
        
        const newMessage = {
            store: store || '전체',
            week: week || '전체',
            manager: manager || '익명',
            title,
            content,
            isGlobal: !!isGlobal,
            isStoreNotice: !!isStoreNotice,
            comments: [],
            date: moment().tz('Asia/Seoul').format('YYYY-MM-DD'),
            createdAt: new Date()
        };

        await collection.insertOne(newMessage);
        
        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, messages: messages.map(m => ({ ...m, id: m._id })) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '게시글 저장 실패' });
    }
});

// 게시글 삭제
router.delete('/api/messages/:id', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection(messageCollectionName);
        const { id } = req.params;
        
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        await collection.deleteOne({ _id: new ObjectId(id) });
        
        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, messages: messages.map(m => ({ ...m, id: m._id })) });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 댓글 작성
router.post('/api/messages/:id/comments', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection(messageCollectionName);
        const { id } = req.params;
        const { manager, content } = req.body || {};
        
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        const newComment = {
            id: Date.now(),
            manager, 
            content, 
            date: moment().tz('Asia/Seoul').format('YYYY-MM-DD')
        };

        await collection.updateOne(
            { _id: new ObjectId(id) },
            { $push: { comments: newComment } }
        );

        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, messages: messages.map(m => ({ ...m, id: m._id })) });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
// ==========================================
// 1. [게시글 본문 수정 API] (DB 연결 수정됨)
// ==========================================
router.put('/api/messages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content } = req.body || {};

        // ID 형식 체크
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: '잘못된 게시글 ID 형식입니다.' });
        }

        // ★ [핵심 수정] 'off' DB를 명시적으로 사용합니다.
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection('messages');

        const result = await collection.updateOne(
            { _id: new ObjectId(id) }, 
            { $set: { title: title, content: content, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다. (ID 불일치 또는 DB 오류)' });
        }

        // 성공 시 최신 목록 반환
        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, messages: messages.map(m => ({ ...m, id: m._id })) });

    } catch (err) {
        console.error("게시글 수정 에러:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 2. [댓글 수정 API] (DB 연결 수정됨 + ID 자동 처리)
// ==========================================
router.put('/api/messages/:id/comments/:cmtId', async (req, res) => {
    try {
        const msgId = req.params.id;
        const cmtIdParam = req.params.cmtId; 
        const { content } = req.body || {};

        if (!ObjectId.isValid(msgId)) {
            return res.status(400).json({ success: false, message: '게시글 ID 오류' });
        }

        // ★ [핵심 수정] 'off' DB를 명시적으로 사용합니다.
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection('messages');

        // 1차 시도: 댓글 ID를 '숫자'로 변환해서 찾아봄
        let result = await collection.updateOne(
            { _id: new ObjectId(msgId), "comments.id": Number(cmtIdParam) },
            { $set: { "comments.$.content": content } }
        );

        // 2차 시도: 실패했다면 '문자'로 다시 찾아봄
        if (result.matchedCount === 0) {
            result = await collection.updateOne(
                { _id: new ObjectId(msgId), "comments.id": cmtIdParam },
                { $set: { "comments.$.content": content } }
            );
        }

        if (result.matchedCount === 0) {
            console.log(`❌ 수정 실패 - 게시글ID: ${msgId}, 댓글ID: ${cmtIdParam}`);
            return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
        }

        // 성공 시 최신 목록 반환
        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, messages: messages.map(m => ({ ...m, id: m._id })) });

    } catch (err) {
        console.error("댓글 수정 에러:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 댓글 삭제
router.delete('/api/messages/:id/comments/:cmtId', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection(messageCollectionName);
        const { id, cmtId } = req.params;
        
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false });

        await collection.updateOne(
            { _id: new ObjectId(id) },
            { $pull: { comments: { id: parseInt(cmtId) } } }
        );

        const messages = await collection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, messages: messages.map(m => ({ ...m, id: m._id })) });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
// ------------------------------------------
// 2. 근무 시간 (Stats) API - [수정됨]
// ------------------------------------------
const statsCollectionName = 'work_stats';

// 근무시간 조회 (월별 필터링 추가)
router.get('/api/stats', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection(statsCollectionName);
        
        // ★ [핵심] 클라이언트가 요청한 'month' 파라미터를 받음
        const { month } = req.query; 
        
        // month가 있으면 해당 월 데이터만, 없으면 빈 값(혹은 전체) 반환
        const query = month ? { month } : {};

        const stats = await collection.find(query).toArray();
        
        const result = {};
        stats.forEach(doc => {
            if (!result[doc.week]) result[doc.week] = {};
            result[doc.week][doc.name] = { hours: doc.hours };
        });
        
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// 근무시간 저장 (월 정보 추가 저장)
router.post('/api/stats', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection(statsCollectionName);
        
        // ★ [핵심] body에서 month도 같이 받음
        const { week, name, hours, month } = req.body || {};
        
        if (!month) return res.status(400).json({ success: false, message: 'Month is required' });

        await collection.updateOne(
            { week, name, month }, // ★ 조건에 month 추가 (그래야 다른 월과 겹치지 않음)
            { $set: { hours: Number(hours), updatedAt: new Date() } },
            { upsert: true }
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});
// ------------------------------------------
// 3. 서포터 (Supporters) API
// ------------------------------------------
router.get('/api/supporters', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off'); // ★ off DB 사용
        const collection = dbOff.collection('supporters');
        
        const { store } = req.query;
        const query = store && store !== 'all' ? { store } : {};
        
        const list = await collection.find(query).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, list: list.map(item => ({ ...item, id: item._id })) });
    } catch (err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

router.post('/api/supporters', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection('supporters');
        
        await collection.insertOne({ ...req.body, createdAt: new Date() });
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

router.put('/api/supporters/:id', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection('supporters');
        
        await collection.updateOne(
            { _id: new ObjectId(req.params.id) }, 
            { $set: { ...req.body, updatedAt: new Date() } }
        );
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

router.delete('/api/supporters/:id', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const collection = dbOff.collection('supporters');
        
        await collection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

// ------------------------------------------
// 4. 매장 링크 토큰 관리 (Store Tokens) API
// ------------------------------------------

// 토큰 목록 조회 (팝업용 - 이게 없어서 4번째 스샷 에러 발생)
router.get('/api/store-tokens', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off'); // ★ off DB 사용
        const tokens = await dbOff.collection('store_tokens').find({}).toArray();
        
        const map = {};
        tokens.forEach(t => { map[t.store] = t.token; });
        
        res.json({ success: true, tokens: map });
    } catch (err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

// 토큰 생성 (신규)
router.post('/api/store-token', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const { store } = req.body || {};
        const token = `store_${Math.random().toString(36).substring(2, 10)}`;
        
        await dbOff.collection('store_tokens').updateOne(
            { store },
            { $set: { token, createdAt: new Date() } },
            { upsert: true }
        );
        res.json({ success: true, token, store });
    } catch (err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

// 토큰 검증 (접속용)
router.get('/api/store-token/:token', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off');
        const { token } = req.params;
        
        const data = await dbOff.collection('store_tokens').findOne({ token });
        if (!data) return res.status(404).json({ success: false });
        
        res.json({ success: true, store: data.store });
    } catch (err) { 
        res.status(500).json({ success: false }); 
    }
});

// [API] 최신 DB 업데이트 시간 조회 (최종_진짜_최종.js)
router.get('/api/system/last-update', async (req, res) => {
    try {
        // 1. 현재 연결된 DB 이름 확인 (콘솔창에서 확인 가능)
        console.log(`🔎 현재 서버가 보고 있는 DB: ${db.databaseName}`);

        // 2. 일단 현재 DB에서 찾아봅니다.
        let meta = await db.collection('system_metadata').findOne({ key: 'last_update_time' });

        // 3. 만약 없으면? 'off' DB를 강제로 한 번 더 뒤져봅니다.
        if (!meta) {
            console.log("⚠️ 현재 DB에 없음. 'off' DB에서 재검색 시도...");
            // ★ 핵심: client 변수 대신 db.client를 쓰면 에러가 안 납니다!
            const dbOff = db.client.db('off'); 
            meta = await dbOff.collection('system_metadata').findOne({ key: 'last_update_time' });
        }

        // 4. 결과 반환
        if (meta && meta.timestamp) {
            console.log("✅ 데이터 찾음:", meta.timestamp);
            res.json({ success: true, timestamp: meta.timestamp });
        } else {
            console.log("❌ 어느 DB에도 데이터가 없습니다.");
            res.json({ success: false, message: '기록 없음', checkedDb: db.databaseName });
        }
    } catch (err) {
        console.error("API 에러:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// ★ [NEW] 오프라인 주문 API (MongoDB 연동)
// ==========================================

// 1. 주문 완료 (POST) - DB 저장
router.post('/api/orders', async (req, res) => {
    try {
        // 본문에 고객 이름·전화·주소가 있어 통째로 남기지 않는다
        console.log('[API] 주문 요청 수신:', (req.body || {}).product_name);

        const {
            product_no,
            product_name,
            selected_option,
            price,
            quantity,
            total_price,
            customer_name,
            customer_phone,
            address,
            manager_name,
            shipping_cost
        } = req.body || {};

        // 필수 데이터 검증
        if (!product_name || !customer_name) {
            return res.status(400).json({ success: false, message: '필수 정보 누락' });
        }

        // MongoDB에 저장할 데이터 객체 생성
        const orderData = {
            product_no,
            product_name,
            option_name: selected_option || '단일옵션',
            price: Number(price) || 0,
            quantity: Number(quantity) || 1,
            shipping_cost: Number(shipping_cost) || 0,
            total_amount: Number(total_price) || 0,
            customer_name,
            customer_phone,
            address,
            manager_name,
            created_at: new Date() // 날짜는 Date 객체로 저장
        };

        // DB 컬렉션에 삽입 (collectionName: offline_orders)
        const collection = db.collection(orderCollectionName);
        const result = await collection.insertOne(orderData);

        console.log('[DB] 주문 저장 완료. ID:', result.insertedId);

        res.json({ success: true, message: '주문이 등록되었습니다.', orderId: result.insertedId });

    } catch (error) {
        console.error('[에러] 주문 저장 실패:', error);
        res.status(500).json({ success: false, message: '서버 에러 발생', error: error.message });
    }
});

router.get('/api/orders', async (req, res) => {
    try {
        const dbOff = mongoClient.db('off'); 
        const { searchType, startDate, endDate, month, store } = req.query; 
        
        let listQuery = {};
        let currentMonth = '';
        let dayLimit = null;  // ★ 진행 중인 달의 '오늘 일자' (예: 14)

        if (searchType === 'range' && startDate && endDate) {
            // [기간 설정] 사용자가 직접 일자 지정
            listQuery.date = { $gte: startDate, $lte: endDate };
            currentMonth = startDate.substring(0, 7); 
            // endDate의 일(day)을 기준으로 작년/전월도 같은 일까지만 비교
            dayLimit = parseInt(endDate.split('-')[2], 10);
        } else {
            // [월별 조회]
            currentMonth = month || moment().tz('Asia/Seoul').format('YYYY-MM');
            listQuery.date = { $regex: `^${currentMonth}` };
            
            // ★ 이번 달이 '진행 중'이면 오늘 일자만큼만 비교 (공정 비교)
            const todayMoment = moment().tz('Asia/Seoul');
            if (currentMonth === todayMoment.format('YYYY-MM')) {
                dayLimit = todayMoment.date(); 
            }
            // 지난 달 조회 시에는 dayLimit = null → 월 전체 비교
        }

        if (store && store !== 'all') {
            listQuery.store = store;
        }

        const currMoment = moment(currentMonth + '-01');
        const prevMonth = currMoment.clone().subtract(1, 'months').format('YYYY-MM');
        const prevYear  = currMoment.clone().subtract(1, 'years').format('YYYY-MM');

        // ★ [핵심 수정] 작년/전월 합계 조회 시 dayLimit 적용
        const getMonthlySum = async (targetMonth) => {
            let query = {};
            
            if (dayLimit) {
                // 동일 일자까지만 잘라서 비교 (예: 작년 5월 1~14일)
                const startDay = `${targetMonth}-01`;
                const endDay   = `${targetMonth}-${String(dayLimit).padStart(2, '0')}`;
                query.date = { $gte: startDay, $lte: endDay };
            } else {
                // 지난 달 조회면 월 전체
                query.date = { $regex: `^${targetMonth}` };
            }
            
            if (store && store !== 'all') {
                query.store = store;
            }
            
            const result = await dbOff.collection('orders').aggregate([
                { $match: query },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]).toArray();
            
            return result.length > 0 ? result[0].total : 0;
        };

        // 🔥 [수정] 진행 중인 월이면 currSum도 MTD(이번 달 1일~오늘)로 잘라서 비교
        //   - 작년/전월은 이미 dayLimit으로 MTD 자르고 있는데 currSum만 전체 월이었음
        //   - 미래 일자 데이터가 있거나 월말로 가면 비교가 어긋남
        const getCurrentSum = async () => {
            let query = { ...listQuery };
            if (dayLimit && !startDate && !endDate) {
                // 월별 진행중 조회 모드: 1일 ~ 오늘까지로 명시적 자름
                const startDay = `${currentMonth}-01`;
                const endDay   = `${currentMonth}-${String(dayLimit).padStart(2, '0')}`;
                query.date = { $gte: startDay, $lte: endDay };
            }
            const result = await dbOff.collection('orders').aggregate([
                { $match: query },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]).toArray();
            return result.length > 0 ? result[0].total : 0;
        };

        const [currSum, prevSum, yearSum] = await Promise.all([
            getCurrentSum(), 
            getMonthlySum(prevMonth),
            getMonthlySum(prevYear)
        ]);

        const projection = {
            orderNo: 1, date: 1, month: 1, week: 1, 
            store: 1, manager: 1, category: 1, beadType: 1,
            productName: 1, color: 1, qty: 1, amount: 1,
            orderHasSet: 1, orderHasCover: 1
        };

        const orders = await dbOff.collection('orders')
            .find(listQuery)
            .project(projection)
            .toArray();
        
        res.json({ 
            success: true, 
            orders, 
            stats: { 
                current: currSum, 
                prevMonth: prevSum, 
                prevYear: yearSum 
            } 
        });

    } catch (err) { 
        console.error(err);
        res.status(500).json({ success: false, error: err.message }); 
    }
});
// ==========================================
// ★ [NEW] 재고 조회 API (yogibo_stock DB 연동)
// ==========================================

// 재고 전용 DB 및 컬렉션 이름 설정
const stockDbName = 'yogibo_stock';
const stockCollectionName = 'stocks';

// 재고 목록 — GET /api/stock/:category 와 index.js의 일일 재고 스냅샷이 함께 쓴다
// (예전엔 스냅샷이 realtime 서버의 /api/stock/전체 를 HTTP로 불렀다)
async function getStockItems(category) {
    let query = {};

    // 카테고리 조건 설정 ('전체'가 아닐 때만 필터링)
    if (category && category !== '전체') {
        query.category = category;
    }

    return mongoClient.db(stockDbName).collection(stockCollectionName)
        .find(query)
        .project({ _id: 0 })
        .toArray();
}

router.get('/api/stock/:category', async (req, res) => {
    try {
        const data = await getStockItems(req.params.category);
        res.json(data);

    } catch (error) {
        console.error('🔥 재고 조회 API 오류:', error);
        res.status(500).json({ error: "재고 데이터를 불러오는 중 서버 오류가 발생했습니다." });
    }
});
// ==========================================
// ★ [수정됨] 엑셀 다운로드 API (업데이트 시간 제거, 날짜 파일명)
// ==========================================
router.get('/api/download/stock', async (req, res) => {
    try {
        // 1. DB 및 컬렉션 직접 지정
        const stockDb = mongoClient.db(stockDbName);
        const collection = stockDb.collection(stockCollectionName);

        // 2. DB에서 전체 데이터 가져오기
        const data = await collection.find({}).project({ _id: 0 }).toArray();

        // 3. 엑셀 생성 (ExcelJS) — index.js처럼 쓸 때만 불러온다
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('재고리스트');

        // 4. 헤더 설정 (업데이트 시간 제거함)
        worksheet.columns = [
            { header: '분류', key: 'category', width: 10 },
            { header: '품목코드', key: 'code', width: 15 },
            { header: '상품명', key: 'name', width: 30 },
            { header: '옵션(컬러)', key: 'spec', width: 20 },
            { header: '재고수량', key: 'qty', width: 10 },
        ];

        // 5. 데이터 가공 및 추가
        data.forEach(item => {
            worksheet.addRow({
                category: item.category,
                code: item.code,
                name: item.name,
                spec: item.spec,
                qty: item.qty
                // updatedAt 제거됨
            });
        });

        // 6. 파일명 생성 (예: Stock_List_2026-01-14.xlsx)
        const fileName = `Stock_List_${moment().tz('Asia/Seoul').format('YYYY-MM-DD')}.xlsx`;

        // 7. 헤더 설정 및 전송
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        // 파일명 인코딩 (한글이나 특수문자 깨짐 방지용 안전장치 포함)
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("🔥 엑셀 다운로드 오류:", error);
        res.status(500).send("엑셀 다운로드 중 오류가 발생했습니다.");
    }
});

// ==========================================
// ★ [NEW] 매장별 창고 재고 API (warehouse DB — 이카운트 창고별재고현황 스냅샷)
//   데이터 적재: Desktop/자동/Ecount/uploadToMongo.js (매장 창고 = "매장-(위치)브랜드" / 데모 창고 = "데모-(위치)브랜드")
// ==========================================
const WAREHOUSE_DB = 'warehouse';
const WAREHOUSE_COLLECTION = 'stocks';

// 매장 토큰 이름(store_tokens.store) → 이카운트 창고명 매칭
// 예) "스타필드고양" ↔ "매장-(고양)스타필드", "신세계센텀시티몰" ↔ "매장-(부산)신세계 센텀시티몰"
function matchStoreWarehouse(storeName, warehouseName) {
    const norm = s => String(s || '').replace(/[\s·.]/g, '');
    const storeNorm = norm(storeName);
    if (!storeNorm) return false;

    const m = String(warehouseName).match(/^(매장|데모)-\((.+?)\)(.*)$/);
    if (!m) return false;
    // 위치는 "명동/본점"처럼 복수 표기 가능 → 분리해서 하나라도 포함되면 인정
    const locParts = m[2].split('/').map(norm).filter(Boolean);
    const brandNorm = norm(m[3]);      // 브랜드: 스타필드, 롯데백화점, 신세계센텀시티몰...
    const brandCore = brandNorm.replace(/(백화점|아울렛|몰)$/, ''); // 롯데백화점→롯데, NC아울렛→NC

    // 규칙 1: 매장명이 위치와 브랜드 핵심어를 모두 포함 (스타필드고양 ⊃ 고양+스타필드)
    if (locParts.some(loc => storeNorm.includes(loc)) && brandCore && storeNorm.includes(brandCore)) return true;
    // 규칙 2: 브랜드명 자체가 매장명과 일치 (신세계센텀시티몰)
    if (brandNorm && (brandNorm === storeNorm || storeNorm === brandCore)) return true;
    return false;
}

router.get('/api/warehouse-stock', async (req, res) => {
    try {
        const storeName = String(req.query.store || '').trim();
        if (!storeName) {
            return res.status(400).json({ success: false, message: 'store 파라미터가 필요합니다.' });
        }

        const col = mongoClient.db(WAREHOUSE_DB).collection(WAREHOUSE_COLLECTION);

        // 최신 스냅샷 날짜 조회
        const latest = await col.find({}).sort({ snapshotDate: -1 }).limit(1).project({ snapshotDate: 1 }).toArray();
        if (latest.length === 0) {
            return res.json({ success: false, message: '적재된 창고 재고 데이터가 없습니다.' });
        }
        const snapshotDate = latest[0].snapshotDate;

        const docs = await col.find({ snapshotDate }).project({ _id: 0 }).toArray();

        // 전체 창고명 수집 → 이 매장에 해당하는 창고 찾기
        const allWarehouses = new Set();
        docs.forEach(d => Object.keys(d.locations || {}).forEach(w => allWarehouses.add(w)));

        const storeWarehouses = [];  // 매장-(판매) 창고
        const demoWarehouses = [];   // 데모-(전시) 창고
        allWarehouses.forEach(w => {
            if (!matchStoreWarehouse(storeName, w)) return;
            if (w.startsWith('매장-')) storeWarehouses.push(w);
            else if (w.startsWith('데모-')) demoWarehouses.push(w);
        });

        if (storeWarehouses.length === 0 && demoWarehouses.length === 0) {
            return res.json({
                success: false,
                message: `'${storeName}' 매장에 매핑된 창고를 찾을 수 없습니다.`,
                snapshotDate
            });
        }

        // 매핑된 창고에 재고가 있는 품목만 추출
        const items = [];
        docs.forEach(d => {
            const loc = d.locations || {};
            let storeQty = 0, demoQty = 0;
            storeWarehouses.forEach(w => { storeQty += Number(loc[w]) || 0; });
            demoWarehouses.forEach(w => { demoQty += Number(loc[w]) || 0; });
            if (storeQty !== 0 || demoQty !== 0) {
                items.push({
                    group: d.itemGroup || '기타',
                    code: d.itemCode,
                    name: d.itemName,
                    spec: d.spec,
                    storeQty,
                    demoQty
                });
            }
        });

        res.json({
            success: true,
            store: storeName,
            snapshotDate,
            storeWarehouses,
            demoWarehouses,
            items
        });
    } catch (error) {
        console.error('🔥 매장 창고 재고 API 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류', error: error.message });
    }
});

module.exports = { router, init, getStockItems };
