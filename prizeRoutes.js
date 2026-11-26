// ==========================================
// 🎁 경품 재고 관리 (2026-11 영업팀 요청)
// ------------------------------------------
// 주간보고.html [일일 마감] 옆 [경품 재고 관리] 버튼에서 쓴다.
//   본사(통합 PIN): 이벤트 + 경품 상품명 등록, 매장별 할당 수량 설정, 매장별·전체 사용/잔여 현황
//   매장(?key= 매장 링크): 우리 매장 할당·사용·잔여 확인, 날짜별 사용 수량 입력
// 매장 노출: 이벤트마다 '매장 노출 시작일'(visible_from) 이후부터 매장 화면에 보인다 (기본 2026-12-04).
//
// DB: off (주간보고·매장 토큰 store_tokens 와 같은 DB)
//   prize_events      { name, start_date, end_date, visible_from, status:'active'|'closed', items:[{id,name}] }
//   prize_allocations { event_id, item_id, store, qty }            — (event_id, item_id, store) 하나
//   prize_usage       { event_id, item_id, store, date, qty, writer, note, created_at }
//   잔여 = 할당 − 사용 기록 합계
// ==========================================
const express = require('express');
const { ObjectId } = require('mongodb');

const router = express.Router();
let mongoClient; // index.js와 같은 연결

const DB_NAME = process.env.PRIZE_DB || 'off'; // 시험 때만 다른 DB 이름을 준다
const DEFAULT_VISIBLE_FROM = '2026-12-04';
const MAX_QTY = 100000;

const C_EVENTS = 'prize_events';
const C_ALLOC = 'prize_allocations';
const C_USAGE = 'prize_usage';

function init(client) {
    mongoClient = client;
    ensureIndexes().catch(e => console.error('⚠️ 경품 인덱스 생성 실패:', e.message));
}

async function ensureIndexes() {
    await col(C_ALLOC).createIndex({ event_id: 1, item_id: 1, store: 1 }, { unique: true });
    await col(C_USAGE).createIndex({ event_id: 1, store: 1, date: -1 });
}

const col = name => mongoClient.db(DB_NAME).collection(name);

// ---------- 유틸 ----------
function todayKST() {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toObjectId = s => (typeof s === 'string' && ObjectId.isValid(s) && /^[0-9a-f]{24}$/i.test(s)) ? new ObjectId(s) : null;
function toInt(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
}
const cleanText = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newItemId = () => `it_${Math.random().toString(36).slice(2, 10)}`;
const fail = (res, status, message) => res.status(status).json({ success: false, message });

function isVisibleToStore(ev, today = todayKST()) {
    return ev.status === 'active' && (ev.visible_from || DEFAULT_VISIBLE_FROM) <= today;
}

function publicEvent(ev) {
    return {
        id: String(ev._id),
        name: ev.name,
        start_date: ev.start_date || '',
        end_date: ev.end_date || '',
        visible_from: ev.visible_from || DEFAULT_VISIBLE_FROM,
        status: ev.status,
        items: (ev.items || []).map(it => ({ id: it.id, name: it.name })),
        created_at: ev.created_at,
        updated_at: ev.updated_at,
    };
}

// 이벤트 입력값 정리 — items 는 [{id?, name}] (id 가 있으면 기존 경품, 없으면 새 경품)
function parseEventBody(body, existingItems = []) {
    const name = cleanText(body?.name, 60);
    if (!name) return { error: '이벤트명을 입력해 주세요.' };

    const start_date = body?.start_date ? String(body.start_date) : '';
    const end_date = body?.end_date ? String(body.end_date) : '';
    const visible_from = body?.visible_from ? String(body.visible_from) : DEFAULT_VISIBLE_FROM;
    if (start_date && !isDate(start_date)) return { error: '시작일 형식이 올바르지 않습니다.' };
    if (end_date && !isDate(end_date)) return { error: '종료일 형식이 올바르지 않습니다.' };
    if (!isDate(visible_from)) return { error: '매장 노출 시작일 형식이 올바르지 않습니다.' };
    if (start_date && end_date && start_date > end_date) return { error: '종료일이 시작일보다 빠릅니다.' };

    const status = body?.status === 'closed' ? 'closed' : 'active';

    const existingIds = new Set(existingItems.map(it => it.id));
    const seen = new Set();
    const items = [];
    for (const raw of Array.isArray(body?.items) ? body.items : []) {
        const itemName = cleanText(raw?.name, 60);
        if (!itemName) continue;
        if (seen.has(itemName)) return { error: `경품 '${itemName}'이(가) 두 번 들어갔습니다.` };
        seen.add(itemName);
        const id = (raw?.id && existingIds.has(raw.id)) ? raw.id : newItemId();
        items.push({ id, name: itemName });
    }
    if (items.length === 0) return { error: '경품 상품명을 하나 이상 입력해 주세요.' };
    if (items.length > 50) return { error: '경품은 한 이벤트에 50개까지 넣을 수 있습니다.' };

    return { value: { name, start_date, end_date, visible_from, status, items } };
}

// 이벤트의 매장×경품 할당·사용 합계
async function loadTotals(eventId, store) {
    const match = { event_id: eventId };
    if (store) match.store = store;
    const [allocs, usedAgg] = await Promise.all([
        col(C_ALLOC).find(match).toArray(),
        col(C_USAGE).aggregate([
            { $match: match },
            { $group: { _id: { store: '$store', item_id: '$item_id' }, used: { $sum: '$qty' } } },
        ]).toArray(),
    ]);
    const map = {}; // map[store][item_id] = { allocated, used }
    const cell = (s, i) => {
        if (!map[s]) map[s] = {};
        if (!map[s][i]) map[s][i] = { allocated: 0, used: 0 };
        return map[s][i];
    };
    allocs.forEach(a => { cell(a.store, a.item_id).allocated = a.qty || 0; });
    usedAgg.forEach(u => { cell(u._id.store, u._id.item_id).used = u.used || 0; });
    return map;
}

async function storeFromToken(token) {
    if (!token || typeof token !== 'string') return null;
    const doc = await col('store_tokens').findOne({ token });
    return doc?.store || null;
}

async function findEvent(id) {
    const _id = toObjectId(id);
    if (!_id) return null;
    return col(C_EVENTS).findOne({ _id });
}

// DB 연결 전 요청은 막는다 (라우터가 연결보다 먼저 붙는다)
router.use('/api/prize', (req, res, next) => {
    if (!mongoClient) return fail(res, 503, '서버가 아직 준비 중입니다. 잠시 후 다시 시도해 주세요.');
    next();
});

// ==========================================
// 본사 (영업 담당) API
// ==========================================

// 이벤트 목록 + 합계
router.get('/api/prize/admin/events', async (req, res) => {
    try {
        const events = await col(C_EVENTS).find({}).sort({ created_at: -1 }).toArray();
        const ids = events.map(e => String(e._id));
        const [allocAgg, usedAgg] = await Promise.all([
            col(C_ALLOC).aggregate([{ $match: { event_id: { $in: ids } } }, { $group: { _id: '$event_id', qty: { $sum: '$qty' } } }]).toArray(),
            col(C_USAGE).aggregate([{ $match: { event_id: { $in: ids } } }, { $group: { _id: '$event_id', qty: { $sum: '$qty' } } }]).toArray(),
        ]);
        const allocBy = Object.fromEntries(allocAgg.map(a => [a._id, a.qty]));
        const usedBy = Object.fromEntries(usedAgg.map(a => [a._id, a.qty]));
        const list = events.map(ev => {
            const id = String(ev._id);
            const allocated = allocBy[id] || 0;
            const used = usedBy[id] || 0;
            return { ...publicEvent(ev), totals: { allocated, used, remaining: allocated - used } };
        });
        // 진행중 먼저
        list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
        res.json({ success: true, today: todayKST(), events: list });
    } catch (e) {
        console.error('[prize] 이벤트 목록 실패:', e);
        fail(res, 500, '이벤트 목록을 불러오지 못했습니다.');
    }
});

// 이벤트 만들기
router.post('/api/prize/admin/events', async (req, res) => {
    try {
        const parsed = parseEventBody(req.body);
        if (parsed.error) return fail(res, 400, parsed.error);
        const now = new Date();
        const doc = { ...parsed.value, created_at: now, updated_at: now };
        const r = await col(C_EVENTS).insertOne(doc);
        res.json({ success: true, event: publicEvent({ ...doc, _id: r.insertedId }) });
    } catch (e) {
        console.error('[prize] 이벤트 생성 실패:', e);
        fail(res, 500, '이벤트를 저장하지 못했습니다.');
    }
});

// 이벤트 수정 (이름·기간·노출일·상태·경품 목록)
router.put('/api/prize/admin/events/:id', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const parsed = parseEventBody(req.body, ev.items || []);
        if (parsed.error) return fail(res, 400, parsed.error);

        const eventId = String(ev._id);
        const keepIds = new Set(parsed.value.items.map(it => it.id));
        const removed = (ev.items || []).filter(it => !keepIds.has(it.id));
        if (removed.length) {
            const usedRemoved = await col(C_USAGE).distinct('item_id', { event_id: eventId, item_id: { $in: removed.map(it => it.id) } });
            if (usedRemoved.length) {
                const names = removed.filter(it => usedRemoved.includes(it.id)).map(it => it.name).join(', ');
                return fail(res, 400, `매장 사용 기록이 있는 경품은 뺄 수 없습니다: ${names}`);
            }
            await col(C_ALLOC).deleteMany({ event_id: eventId, item_id: { $in: removed.map(it => it.id) } });
        }

        await col(C_EVENTS).updateOne({ _id: ev._id }, { $set: { ...parsed.value, updated_at: new Date() } });
        const updated = await col(C_EVENTS).findOne({ _id: ev._id });
        res.json({ success: true, event: publicEvent(updated) });
    } catch (e) {
        console.error('[prize] 이벤트 수정 실패:', e);
        fail(res, 500, '이벤트를 수정하지 못했습니다.');
    }
});

// 이벤트 삭제 — 사용 기록이 있으면 막고 '종료' 처리를 권한다
router.delete('/api/prize/admin/events/:id', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const eventId = String(ev._id);
        const usedCount = await col(C_USAGE).countDocuments({ event_id: eventId });
        if (usedCount > 0) return fail(res, 400, '매장 사용 기록이 있는 이벤트는 삭제할 수 없습니다. 대신 [종료]로 바꿔 주세요.');
        await col(C_ALLOC).deleteMany({ event_id: eventId });
        await col(C_EVENTS).deleteOne({ _id: ev._id });
        res.json({ success: true });
    } catch (e) {
        console.error('[prize] 이벤트 삭제 실패:', e);
        fail(res, 500, '이벤트를 삭제하지 못했습니다.');
    }
});

// 매장별·전체 현황 (할당 설정 표도 이걸로 그린다)
router.get('/api/prize/admin/events/:id/summary', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const eventId = String(ev._id);
        const [map, tokenStores] = await Promise.all([
            loadTotals(eventId),
            col('store_tokens').distinct('store'),
        ]);
        const stores = [...new Set([...tokenStores.filter(Boolean), ...Object.keys(map)])]
            .sort((a, b) => a.localeCompare(b, 'ko'));
        const items = ev.items || [];

        const itemTotals = {};
        items.forEach(it => { itemTotals[it.id] = { allocated: 0, used: 0, remaining: 0 }; });
        const grand = { allocated: 0, used: 0, remaining: 0 };

        const rows = stores.map(store => {
            const cells = {};
            const total = { allocated: 0, used: 0, remaining: 0 };
            items.forEach(it => {
                const c = map[store]?.[it.id] || { allocated: 0, used: 0 };
                const remaining = c.allocated - c.used;
                cells[it.id] = { allocated: c.allocated, used: c.used, remaining };
                total.allocated += c.allocated; total.used += c.used; total.remaining += remaining;
                itemTotals[it.id].allocated += c.allocated;
                itemTotals[it.id].used += c.used;
                itemTotals[it.id].remaining += remaining;
            });
            grand.allocated += total.allocated; grand.used += total.used; grand.remaining += total.remaining;
            return { store, has_link: tokenStores.includes(store), cells, total };
        });

        res.json({ success: true, today: todayKST(), event: publicEvent(ev), stores, rows, itemTotals, grand });
    } catch (e) {
        console.error('[prize] 현황 조회 실패:', e);
        fail(res, 500, '현황을 불러오지 못했습니다.');
    }
});

// 할당 수량 저장 — [{store, item_id, qty}] 를 한 번에. 0 이면 할당 삭제.
router.put('/api/prize/admin/events/:id/allocations', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const eventId = String(ev._id);
        const itemName = Object.fromEntries((ev.items || []).map(it => [it.id, it.name]));
        const list = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
        if (!list.length) return fail(res, 400, '저장할 할당 수량이 없습니다.');
        if (list.length > 5000) return fail(res, 400, '한 번에 저장할 수 있는 양을 넘었습니다.');

        const clean = [];
        for (const a of list) {
            const store = cleanText(a?.store, 60);
            const qty = toInt(a?.qty);
            if (!store) return fail(res, 400, '매장명이 비어 있는 줄이 있습니다.');
            if (!itemName[a?.item_id]) return fail(res, 400, '이벤트에 없는 경품이 들어왔습니다. 새로고침 후 다시 시도해 주세요.');
            if (qty === null || qty < 0 || qty > MAX_QTY) return fail(res, 400, `${store} · ${itemName[a.item_id]}: 수량은 0~${MAX_QTY} 사이 정수로 입력해 주세요.`);
            clean.push({ store, item_id: a.item_id, qty });
        }

        // 이미 쓴 수량보다 적게 할당할 수는 없다
        const map = await loadTotals(eventId);
        const errors = clean
            .filter(a => (map[a.store]?.[a.item_id]?.used || 0) > a.qty)
            .map(a => `${a.store} · ${itemName[a.item_id]} (이미 ${map[a.store][a.item_id].used}개 사용)`);
        if (errors.length) return fail(res, 400, `이미 사용한 수량보다 적게 할당할 수 없습니다:\n${errors.slice(0, 10).join('\n')}`);

        const now = new Date();
        const ops = clean.map(a => {
            const filter = { event_id: eventId, item_id: a.item_id, store: a.store };
            return a.qty === 0
                ? { deleteOne: { filter } }
                : { updateOne: { filter, update: { $set: { qty: a.qty, updated_at: now }, $setOnInsert: { created_at: now } }, upsert: true } };
        });
        await col(C_ALLOC).bulkWrite(ops, { ordered: false });
        await col(C_EVENTS).updateOne({ _id: ev._id }, { $set: { updated_at: now } });
        res.json({ success: true, saved: clean.length });
    } catch (e) {
        console.error('[prize] 할당 저장 실패:', e);
        fail(res, 500, '할당 수량을 저장하지 못했습니다.');
    }
});

// 사용 기록 (전체 또는 매장 하나)
router.get('/api/prize/admin/events/:id/usage', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const q = { event_id: String(ev._id) };
        if (req.query.store) q.store = String(req.query.store);
        const logs = await col(C_USAGE).find(q).sort({ date: -1, created_at: -1 }).limit(2000).toArray();
        res.json({ success: true, logs: logs.map(l => ({ ...l, _id: String(l._id) })) });
    } catch (e) {
        console.error('[prize] 사용 기록 조회 실패:', e);
        fail(res, 500, '사용 기록을 불러오지 못했습니다.');
    }
});

// 사용 기록 삭제 (본사 정정용)
router.delete('/api/prize/admin/usage/:id', async (req, res) => {
    try {
        const _id = toObjectId(req.params.id);
        if (!_id) return fail(res, 400, '잘못된 기록입니다.');
        const r = await col(C_USAGE).deleteOne({ _id });
        if (!r.deletedCount) return fail(res, 404, '이미 지워진 기록입니다.');
        res.json({ success: true });
    } catch (e) {
        console.error('[prize] 사용 기록 삭제 실패:', e);
        fail(res, 500, '사용 기록을 지우지 못했습니다.');
    }
});

// ==========================================
// 매장 API — 주간보고 매장 링크의 key(store_tokens.token)로 매장을 확인한다.
// 매장명은 토큰에서만 읽어서 다른 매장 데이터를 건드릴 수 없다.
// ==========================================

// 우리 매장에 보이는 이벤트·경품 (빈 목록이면 버튼을 숨긴다)
router.get('/api/prize/store/:token', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '매장 링크가 올바르지 않습니다.');
        const today = todayKST();
        const events = (await col(C_EVENTS).find({ status: 'active' }).sort({ created_at: -1 }).toArray())
            .filter(ev => isVisibleToStore(ev, today));

        const out = [];
        for (const ev of events) {
            const map = await loadTotals(String(ev._id), store);
            const items = (ev.items || [])
                .map(it => {
                    const c = map[store]?.[it.id] || { allocated: 0, used: 0 };
                    return { id: it.id, name: it.name, allocated: c.allocated, used: c.used, remaining: c.allocated - c.used };
                })
                .filter(it => it.allocated > 0 || it.used > 0);
            if (items.length) {
                const p = publicEvent(ev);
                out.push({ id: p.id, name: p.name, start_date: p.start_date, end_date: p.end_date, visible_from: p.visible_from, items });
            }
        }
        res.json({ success: true, store, today, events: out });
    } catch (e) {
        console.error('[prize] 매장 경품 조회 실패:', e);
        fail(res, 500, '경품 정보를 불러오지 못했습니다.');
    }
});

// 우리 매장 사용 기록
router.get('/api/prize/store/:token/usage', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '매장 링크가 올바르지 않습니다.');
        const q = { store };
        if (req.query.event_id) q.event_id = String(req.query.event_id);
        const logs = await col(C_USAGE).find(q).sort({ date: -1, created_at: -1 }).limit(500).toArray();
        res.json({ success: true, logs: logs.map(l => ({ ...l, _id: String(l._id) })) });
    } catch (e) {
        console.error('[prize] 매장 사용 기록 조회 실패:', e);
        fail(res, 500, '사용 기록을 불러오지 못했습니다.');
    }
});

// 사용 수량 입력
router.post('/api/prize/store/:token/usage', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '매장 링크가 올바르지 않습니다.');
        const today = todayKST();

        const ev = await findEvent(req.body?.event_id);
        if (!ev || !isVisibleToStore(ev, today)) return fail(res, 400, '지금 입력할 수 있는 이벤트가 아닙니다.');
        const eventId = String(ev._id);
        const item = (ev.items || []).find(it => it.id === req.body?.item_id);
        if (!item) return fail(res, 400, '경품을 선택해 주세요.');

        const date = String(req.body?.date || today);
        if (!isDate(date)) return fail(res, 400, '날짜를 확인해 주세요.');
        if (date > today) return fail(res, 400, '오늘 이후 날짜는 입력할 수 없습니다.');
        if (date < (ev.visible_from || DEFAULT_VISIBLE_FROM)) return fail(res, 400, `${ev.visible_from || DEFAULT_VISIBLE_FROM} 이전 날짜는 입력할 수 없습니다.`);

        const qty = toInt(req.body?.qty);
        if (qty === null || qty < 1 || qty > MAX_QTY) return fail(res, 400, '사용 수량은 1 이상 정수로 입력해 주세요.');

        const writer = cleanText(req.body?.writer, 20);
        const note = cleanText(req.body?.note, 100);

        const map = await loadTotals(eventId, store);
        const c = map[store]?.[item.id] || { allocated: 0, used: 0 };
        if (c.allocated <= 0) return fail(res, 400, '우리 매장에 할당되지 않은 경품입니다.');
        if (c.used + qty > c.allocated) return fail(res, 400, `잔여 수량(${c.allocated - c.used}개)보다 많이 입력할 수 없습니다.`);

        const doc = { event_id: eventId, item_id: item.id, item_name: item.name, store, date, qty, writer, note, created_at: new Date() };
        const r = await col(C_USAGE).insertOne(doc);

        // 두 사람이 동시에 넣어 할당을 넘었으면 방금 넣은 것을 되돌린다
        const after = await loadTotals(eventId, store);
        const usedNow = after[store]?.[item.id]?.used || 0;
        if (usedNow > c.allocated) {
            await col(C_USAGE).deleteOne({ _id: r.insertedId });
            return fail(res, 409, '방금 다른 입력이 들어와 잔여 수량이 바뀌었습니다. 새로고침 후 다시 입력해 주세요.');
        }
        res.json({ success: true, log: { ...doc, _id: String(r.insertedId) } });
    } catch (e) {
        console.error('[prize] 사용 입력 실패:', e);
        fail(res, 500, '사용 수량을 저장하지 못했습니다.');
    }
});

// 우리 매장 사용 기록 삭제 (잘못 넣은 것 정정)
router.delete('/api/prize/store/:token/usage/:id', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '매장 링크가 올바르지 않습니다.');
        const _id = toObjectId(req.params.id);
        if (!_id) return fail(res, 400, '잘못된 기록입니다.');
        const log = await col(C_USAGE).findOne({ _id });
        if (!log || log.store !== store) return fail(res, 404, '기록을 찾을 수 없습니다.');
        const ev = await findEvent(log.event_id);
        if (!ev || ev.status !== 'active') return fail(res, 400, '종료된 이벤트의 기록은 본사에 정정을 요청해 주세요.');
        await col(C_USAGE).deleteOne({ _id });
        res.json({ success: true });
    } catch (e) {
        console.error('[prize] 매장 사용 기록 삭제 실패:', e);
        fail(res, 500, '사용 기록을 지우지 못했습니다.');
    }
});

module.exports = { router, init };
