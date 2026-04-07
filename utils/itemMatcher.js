// utils/itemMatcher.js
const fs = require("fs");
const path = require("path");

// 메모리에 ITEM_CODES 캐싱 (서버 실행 시 한 번만 로드)
let ITEM_CODES = [];
try {
    // 상대 경로는 프로젝트 구조에 맞게 조절했습니다. (utils 폴더 밖의 ITEM_CODES.json 참조)
    const filePath = path.join(__dirname, '../ITEM_CODES.json');
    if (fs.existsSync(filePath)) {
        ITEM_CODES = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        console.log(`✅ 매핑을 위한 ITEM_CODES ${ITEM_CODES.length}개 로드 완료`);
    } else {
        console.warn("⚠️ ITEM_CODES.json 파일을 찾을 수 없습니다. 루트 경로를 확인해주세요.");
    }
} catch (e) {
    console.error("🔥 ITEM_CODES.json 로드 실패:", e);
}

// 예외 매핑 딕셔너리 (기존 프론트엔드의 if문 하드코딩을 딕셔너리로 분리)
const EXCEPTION_MAP = {
    "메가문필로우아쿠아블루": "241104S",
    "메가문필로우아쿠아블루프리미엄": "241104SPre",
    "메가문필로우올리브그린": "241108S",
    "메가문필로우올리브그린프리미엄": "241108SPre",
    "메가문필로우다크그레이": "241112S",
    "메가문필로우다크그레이프리미엄": "241112SPre",
    "메가문필로우라이트그레이": "241113S",
    "메가문필로우라이트그레이프리미엄": "241113SPre"
};

/**
 * 주문 상품명과 옵션명을 분석하여 이카운트 품목코드를 반환합니다.
 * @param {string} orderProdName - Cafe24 상품명
 * @param {string} orderOptionName - Cafe24 옵션명
 * @returns {object} { code: '매핑된코드', score: 매칭점수, status: '상태' }
 */
function matchItemCode(orderProdName, orderOptionName) {
    if (!ITEM_CODES || !ITEM_CODES.length) {
        return { code: '', score: 0, status: 'FAIL' };
    }

    const clean = s => String(s || '').replace(/\s+/g, '').toLowerCase().trim();
    const getFirst = s => s ? s.split('/')[0].trim() : '';

    const pN = clean(orderProdName);
    const oN = clean(orderOptionName);
    const orderFullText = pN + oN;

    // [1] 예외 매핑 사전 검사
    if (EXCEPTION_MAP[orderFullText]) {
        return { code: EXCEPTION_MAP[orderFullText], score: 9999, status: 'EXCEPTION' };
    }

    const extractKw = s => {
        if (!s) return [];
        return String(s).toLowerCase()
            .replace(/[^\w가-힣\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 0)
            .filter(w => !['the', 'and', 'or', 'of', 'yogibo', '요기보'].includes(w));
    };

    // [2] 완전 일치 매칭
    let found = ITEM_CODES.find(item => {
        const dbFN = clean(item.name);
        const dbSN = clean(getFirst(item.name));
        const dbFS = clean(item.spec || '');
        const dbSS = clean(getFirst(item.spec || ''));

        const nm = (dbFN === pN || dbSN === pN); 
        let sm = true;
        if (oN) sm = (dbFS === oN || dbSS === oN);
        return nm && sm;
    });

    if (found) {
        return { code: found.code, score: 5000, status: 'SUCCESS' };
    }

    // [3] 정밀 스코어링 교차 검증
    const orderNameKws = extractKw(orderProdName);
    const orderSpecKws = extractKw(orderOptionName);
    const orderAllKws = [...orderNameKws, ...orderSpecKws];

    const cands = [];

    ITEM_CODES.forEach(item => {
        const dbNameKws = extractKw(getFirst(item.name));
        const dbSpecKws = extractKw(getFirst(item.spec || ''));
        
        if (!dbNameKws.length && !dbSpecKws.length) return;

        let nameMatchCount = 0;
        dbNameKws.forEach(dk => {
            if (orderAllKws.some(ok => ok.includes(dk) || dk.includes(ok))) nameMatchCount++;
        });

        let specMatchCount = 0;
        dbSpecKws.forEach(dk => {
            if (orderAllKws.some(ok => ok.includes(dk) || dk.includes(ok))) specMatchCount++;
        });

        let score = (nameMatchCount * 1000) + (specMatchCount * 100);

        const dbNameMissingInOrder = dbNameKws.length - nameMatchCount;
        score -= (dbNameMissingInOrder * 2000); 

        let orderNameMissingInDb = 0;
        orderNameKws.forEach(ok => {
            if (!dbNameKws.some(dk => dk.includes(ok) || ok.includes(dk))) orderNameMissingInDb++;
        });
        score -= (orderNameMissingInDb * 5); 

        const specMissingCount = dbSpecKws.length - specMatchCount;
        score -= (specMissingCount * 50);

        const dbSN = clean(getFirst(item.name));
        if (dbSN && orderFullText.includes(dbSN)) {
            score += 500;
        }

        if (score > 0) {
            cands.push({ item, score });
        }
    });

    // 스코어가 가장 높은 후보 선정
    if (cands.length > 0) {
        cands.sort((a, b) => b.score - a.score);
        const bestMatch = cands[0];
        
        // 1000점 이상이면 성공, 아니면 수동 검증 요망(WARNING)
        return {
            code: bestMatch.item.code,
            score: bestMatch.score,
            status: bestMatch.score >= 1000 ? 'SUCCESS' : 'WARNING'
        };
    }

    // [4] 최후의 백업
    const fallbackCands = [...ITEM_CODES].sort((a, b) => {
        return clean(getFirst(b.name)).length - clean(getFirst(a.name)).length;
    });
    
    found = fallbackCands.find(item => {
        const dbSN = clean(getFirst(item.name));
        return dbSN && pN.includes(dbSN);
    });

    if (found) {
        return { code: found.code, score: 500, status: 'WARNING' };
    }

    // 최종 실패
    return { code: '', score: 0, status: 'FAIL' };
}

module.exports = { matchItemCode };