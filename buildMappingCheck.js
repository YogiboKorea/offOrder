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
const RESULT_PATH = path.join(__dirname, 'MAPPING_RESULT.json');
// 매핑체크.html same-origin 접근용 — deliveryOFF 폴더에도 동시 출력
const RESULT_PATH_STATIC = path.join(__dirname, '..', 'deliveryOFF', 'MAPPING_RESULT.json');

function main() {
    console.log('========================================');
    console.log('🔍 매핑 체크 사전 계산 시작');
    console.log('========================================');
    const t0 = Date.now();

    if (!fs.existsSync(CAFE24_PATH)) {
        console.error('❌ ITEM_CAFE24.json 파일이 없습니다:', CAFE24_PATH);
        process.exit(1);
    }

    const cafe24Items = JSON.parse(fs.readFileSync(CAFE24_PATH, 'utf-8'));
    console.log(`📦 ITEM_CAFE24 항목: ${cafe24Items.length.toLocaleString()}건`);

    const results = cafe24Items.map((item, idx) => {
        let m = { code: '', score: 0, status: 'FAIL' };
        try { m = matchItemCode(item.name, item.spec); }
        catch (e) { console.warn(`  ⚠ ${item.name} 매칭 오류:`, e.message); }

        if ((idx + 1) % 500 === 0) {
            process.stdout.write(`\r  진행: ${idx + 1}/${cafe24Items.length}`);
        }

        return {
            cafe24_name: item.name,
            cafe24_spec: item.spec || '',
            is_epp_variant: !!item.is_epp_variant,
            ecount_code: m.code,
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
    }, { total: 0, success: 0, warning: 0, fail: 0, exception: 0, epp_total: 0, epp_fail: 0 });

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
