/**
 * 매핑 체크 결과 사전 계산 스크립트
 * - ITEM_CAFE24.json × ITEM_CODES.json 매칭을 로컬에서 모두 끝내고
 * - MAPPING_RESULT.json 파일로 저장
 * - 서버는 이 파일만 정적 서빙 → 무거운 런타임 계산 X
 *
 * 사용:
 *   cd C:\Users\Yogibo Design\Desktop\오프라인
 *   node buildMappingCheck.js
 *
 * JSON 파일 수정 후 이 스크립트만 다시 돌리면 됩니다.
 */
const fs = require('fs');
const path = require('path');
const { matchItemCode } = require('./utils/itemMatcher');

const CAFE24_PATH = path.join(__dirname, 'ITEM_CAFE24.json');
const CODES_PATH = path.join(__dirname, 'ITEM_CODES.json');
const RESULT_PATH = path.join(__dirname, 'MAPPING_RESULT.json');
// 매핑체크.html same-origin 접근용 — deliveryOFF 폴더에도 동시 출력
const RESULT_PATH_STATIC = path.join(__dirname, '..', 'deliveryOFF', 'MAPPING_RESULT.json');

// 매핑 대상이 아닌 더미/안내성 상품 (이카운트 코드 매칭 불필요)
// 신규 더미 추가 시 이 배열에만 넣으면 매핑체크에서 자동 제외됨
const SKIP_NAMES = [
    '요기보를 찾습니다!'
];
const shouldSkip = (name) => SKIP_NAMES.some(s => (name || '').includes(s));

function main() {
    console.log('========================================');
    console.log('🔍 매핑 체크 사전 계산 시작');
    console.log('========================================');
    const t0 = Date.now();

    if (!fs.existsSync(CAFE24_PATH)) {
        console.error('❌ ITEM_CAFE24.json 파일이 없습니다:', CAFE24_PATH);
        process.exit(1);
    }

    // ITEM_CODES → code→{name,spec} 인덱스 (이카운트 코드 옆에 상품명/옵션 표시용)
    let codeIndex = new Map();
    if (fs.existsSync(CODES_PATH)) {
        const codes = JSON.parse(fs.readFileSync(CODES_PATH, 'utf-8'));
        codes.forEach(c => {
            if (c.code && !codeIndex.has(c.code)) {
                codeIndex.set(c.code, { name: c.name || '', spec: c.spec || '' });
            }
        });
        console.log(`📚 ITEM_CODES 인덱스: ${codeIndex.size.toLocaleString()}개`);
    } else {
        console.warn('⚠ ITEM_CODES.json 없음 — 이카운트 상품명/옵션 표시는 비어있음');
    }

    const cafe24ItemsRaw = JSON.parse(fs.readFileSync(CAFE24_PATH, 'utf-8'));
    const cafe24Items = cafe24ItemsRaw.filter(item => !shouldSkip(item.name));
    const skippedCount = cafe24ItemsRaw.length - cafe24Items.length;
    console.log(`📦 ITEM_CAFE24 항목: ${cafe24Items.length.toLocaleString()}건 (제외 ${skippedCount}건)`);
    if (skippedCount > 0) {
        cafe24ItemsRaw.filter(item => shouldSkip(item.name))
            .forEach(item => console.log(`   ⏭  매핑 제외: ${item.name}`));
    }

    const results = cafe24Items.map((item, idx) => {
        let m = { code: '', score: 0, status: 'FAIL' };
        try { m = matchItemCode(item.name, item.spec); }
        catch (e) { console.warn(`  ⚠ ${item.name} 매칭 오류:`, e.message); }

        if ((idx + 1) % 500 === 0) {
            process.stdout.write(`\r  진행: ${idx + 1}/${cafe24Items.length}`);
        }

        const eInfo = m.code ? codeIndex.get(m.code) : null;
        return {
            cafe24_name: item.name,
            cafe24_spec: item.spec || '',
            is_epp_variant: !!item.is_epp_variant,
            ecount_code: m.code,
            ecount_name: eInfo ? eInfo.name : '',
            ecount_spec: eInfo ? eInfo.spec : '',
            score: m.score,
            status: m.status
        };
    });
    process.stdout.write('\n');

    const summary = results.reduce((acc, r) => {
        acc.total++;
        acc[r.status.toLowerCase()] = (acc[r.status.toLowerCase()] || 0) + 1;
        if (r.is_epp_variant) {
            acc.epp_total++;
            if (r.status === 'FAIL') acc.epp_fail++;
        }
        return acc;
    }, { total: 0, success: 0, warning: 0, fail: 0, exception: 0, hardcoded: 0, epp_total: 0, epp_fail: 0 });

    const output = {
        success: true,
        generated_at: new Date().toISOString(),
        elapsed_ms: Date.now() - t0,
        summary,
        data: results
    };

    fs.writeFileSync(RESULT_PATH, JSON.stringify(output, null, 2), 'utf-8');
    try {
        fs.writeFileSync(RESULT_PATH_STATIC, JSON.stringify(output, null, 2), 'utf-8');
        console.log('📁 정적 복사:', RESULT_PATH_STATIC);
    } catch (e) {
        console.warn('⚠ deliveryOFF 복사 실패:', e.message);
    }

    console.log('========================================');
    console.log(`✅ 완료 (${output.elapsed_ms}ms)`);
    console.log('📊 요약:');
    console.log(`   • 전체:     ${summary.total.toLocaleString()}건`);
    console.log(`   • SUCCESS:  ${summary.success.toLocaleString()}건`);
    console.log(`   • WARNING:  ${summary.warning.toLocaleString()}건`);
    console.log(`   • FAIL:     ${summary.fail.toLocaleString()}건`);
    console.log(`   • EXCEPTION:${summary.exception.toLocaleString()}건`);
    console.log(`   • HARDCODED:${summary.hardcoded.toLocaleString()}건 (하드코딩 룰 적중)`);
    console.log(`   • EPP 변형: ${summary.epp_total.toLocaleString()}건 (FAIL ${summary.epp_fail}건)`);
    console.log(`📁 저장: ${RESULT_PATH}`);
    console.log('========================================');
    console.log('\n👉 다음 단계: MAPPING_RESULT.json 파일을 서버에 push 하세요.');
}

try { main(); }
catch (e) {
    console.error('🔥 빌드 실패:', e);
    process.exit(1);
}
