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
 * 하드코딩 매칭 룰 (오프라인 주문서/매장 코드 화면에서 사용하던 if-block을 정리)
 * orderFullText: 공백 제거 + 소문자 변환된 상품명+옵션명 문자열
 * 매칭되면 코드 반환, 아니면 null
 *
 * ⚠️ 이 함수가 반환한 항목은 매핑체크에서 status='HARDCODED'로 표시됨
 *    → 데이터 정규화 시 자동 매칭으로 옮길 후보들
 */
function matchByHardcodedRules(orderFullText) {
    const t = orderFullText;

    // ── 메가문필로우 (커버 / 일반 / 프리미엄 × 4색)
    if (t.includes('메가문필로우')) {
        const isPremium = t.includes('프리미엄');
        const isCover = t.includes('커버');
        if (t.includes('아쿠아블루'))   return isCover ? '241104' : (isPremium ? '241104SPre' : '241104S');
        if (t.includes('올리브그린'))   return isCover ? '241108' : (isPremium ? '241108SPre' : '241108S');
        if (t.includes('다크그레이'))   return isCover ? '241112' : (isPremium ? '241112SPre' : '241112S');
        if (t.includes('라이트그레이')) return isCover ? '241113' : (isPremium ? '241113SPre' : '241113S');
    }

    // ── 요기보 롤 미디 (커버 / 일반 / 프리미엄 / EPP / 플러스 × 7색)
    if (t.includes('요기보롤미디')) {
        let sfx = 'S';
        if (t.includes('커버')) sfx = '';
        else if (t.includes('플러스')) sfx = 'SPre+';
        else if (t.includes('epp')) sfx = 'SHPre';
        else if (t.includes('프리미엄')) sfx = 'SPre';
        if (t.includes('아쿠아블루'))     return '260204' + sfx;
        if (t.includes('로즈핑크'))       return '260205' + sfx;
        if (t.includes('스위트오렌지'))   return '260206' + sfx;
        if (t.includes('올리브그린'))     return '260208' + sfx;
        if (t.includes('다크그레이'))     return '260212' + sfx;
        if (t.includes('라이트그레이'))   return '260213' + sfx;
        if (t.includes('브라이트옐로우')) return '260218' + sfx;
    }

    // ── 냅엑스 × 8색
    if (t.includes('냅엑스')) {
        if (t.includes('네이비블루'))     return '130203-L';
        if (t.includes('아쿠아블루'))     return '130204-L';
        if (t.includes('로즈핑크'))       return '130205-L';
        if (t.includes('스위트오렌지'))   return '130206-L';
        if (t.includes('올리브그린'))     return '130208-L';
        if (t.includes('다크그레이'))     return '130212-L';
        if (t.includes('라이트그레이'))   return '130213-L';
        if (t.includes('브라이트옐로우')) return '130218-L';
    }

    // ── 냅 (엑스 제외) × 6색
    if (t.includes('냅') && !t.includes('엑스')) {
        if (t.includes('아쿠아블루'))   return '130104-L';
        if (t.includes('로즈핑크'))     return '130105-L';
        if (t.includes('스위트오렌지')) return '130106-L';
        if (t.includes('올리브그린'))   return '130108-L';
        if (t.includes('다크그레이'))   return '130112-L';
        if (t.includes('라이트그레이')) return '130113-L';
    }

    // ── 우파루파 롤메이트
    if (t.includes('우파루파롤메이트')) {
        return t.includes('프리미엄') ? '231898SHPre' : '231898S';
    }

    // ── 비즈 충전재 (스탠다드 / 프로 / 프리미엄 × 무게)
    if (t.includes('비즈')) {
        if (t.includes('프리미엄')) {
            if (t.includes('0.35')) return 'HFILL035';
            if (t.includes('0.65')) return 'HFILL065';
        }
        if (t.includes('스탠다드')) {
            if (t.includes('0.4'))  return 'EFILL04';
            if (t.includes('0.75')) return 'EFILL075';
        }
        if (t.includes('프로')) {
            if (t.includes('0.5')) return 'PFILL05';
            if (t.includes('0.3')) return 'PFILL03';
        }
    }

    // ── 메이트 × 캐릭터
    if (t.includes('메이트')) {
        if (t.includes('스프라우트'))   return '131183';
        if (t.includes('써니'))         return '131180';
        if (t.includes('아로'))         return '131182';
        if (t.includes('다니엘'))       return '131130';
        if (t.includes('케빈'))         return '131105';
        if (t.includes('페스터스'))     return '131171';
        if (t.includes('테디'))         return '131123';
        if (t.includes('유니크'))       return '131117';
        if (t.includes('오스왈드'))     return '131116';
        if (t.includes('딜라일라'))     return '131121';
        if (t.includes('버트랜드'))     return '131125';
        if (t.includes('어니스트'))     return '131104';
        if (t.includes('오파'))         return '131191';
        if (t.includes('조젯'))         return '131111';
        if (t.includes('모리슨'))       return '131141';
        if (t.includes('데릭'))         return '131109';
        if (t.includes('디오고'))       return '131103';
        if (t.includes('셸비'))         return '131106';
        if (t.includes('지그프리트'))   return '131124';
        if (t.includes('휴고'))         return '131171';
        if (t.includes('로미'))         return '131129';
        if (t.includes('야머스'))       return '131119NB';
        if (t.includes('칼리스타'))     return '131114';
        if (t.includes('코스모'))       return '131131';
        if (t.includes('사울'))         return '131107';
        if (t.includes('우파루파'))     return '131198';
        if (t.includes('나르왈'))       return '131199';
    }

    // ── 스퀴지보 / 애니멀
    if (t.includes('스퀴지보') || t.includes('애니멀')) {
        if (t.includes('도그') || t.includes('dog'))         return '121601';
        if (t.includes('코알라') || t.includes('koala'))     return '121605';
        if (t.includes('옥토푸스') || t.includes('octopus')) return '121616';
        if (t.includes('유니콘') || t.includes('unicorn'))   return '121617';
        if (t.includes('티렉스') || t.includes('t-rex'))     return '121623';
        if (t.includes('캣') || t.includes('cat'))           return '121631';
    }

    // ── 맥스 프리미엄 아쿠아블루 (직접 매핑)
    if (t.includes('요기보맥스프리미엄') && t.includes('아쿠아블루')) {
        return '200104SPre';
    }

    return null;
}

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

    // [1.5] 하드코딩 룰 검사 (메가문필로우 / 롤미디 / 냅·냅엑스 / 비즈 / 메이트 / 스퀴지보 / 맥스 등)
    const hcCode = matchByHardcodedRules(orderFullText);
    if (hcCode) {
        return { code: hcCode, score: 9000, status: 'HARDCODED' };
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