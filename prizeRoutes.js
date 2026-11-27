// ==========================================
// 🎁 경품 재고 관리 (2026-11 영업팀 요청, 11-27 피드백 반영)
// ------------------------------------------
// 본사: 주간보고.html [일일 마감] 옆 [경품 재고 관리] 팝업
//   이벤트 + 경품 상품명 등록, 매장별 할당 수량, 매장별·전체 현황, 엑셀, 매장별 경품 전용 링크 발급
// 매장: 경품 전용 링크(prize.html?key=경품토큰)로만 들어온다 — 주간보고 매장 링크와 별개
//   우리 매장 할당·사용·잔여 확인, 날짜별 "그날 나간 수량" 한 칸 입력(고치면 덮어쓰기)
// 매장 노출: 이벤트마다 '매장 노출 시작일'(visible_from) 이후부터 매장 화면에 보인다 (기본 2026-12-04).
//
// DB: off
//   prize_events      { name, start_date, end_date, visible_from, status:'active'|'closed', items:[{id,name}] }
//   prize_allocations { event_id, item_id, store, qty }                 — (event_id, item_id, store) 하나
//   prize_usage       { event_id, item_id, item_name, store, date, qty } — (event_id, item_id, store, date) 하나 = 그날 나간 수량
//   prize_links       { store, token, created_at }                        — 매장별 경품 전용 링크
//   잔여 = 할당 − 사용 합계
// 운영 매장 = 직원 명단(yogibo.jwasu_managers)에 ON 직원이 1명 이상인 매장 (통합관리시스템과 같은 기준)
// ==========================================
const express = require('express');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

const router = express.Router();
let mongoClient; // index.js와 같은 연결

const DB_NAME = process.env.PRIZE_DB || 'off'; // 시험 때만 다른 DB 이름을 준다
const STAFF_DB_NAME = process.env.REALTIME_DB_NAME || 'yogibo';
const DEFAULT_VISIBLE_FROM = '2026-12-04';
const MAX_QTY = 100000;

const C_EVENTS = 'prize_events';
const C_ALLOC = 'prize_allocations';
const C_USAGE = 'prize_usage';
const C_LINKS = 'prize_links';

function init(client) {
    mongoClient = client;
    ensureIndexes().catch(e => console.error('⚠️ 경품 인덱스 생성 실패:', e.message));
}

async function ensureIndexes() {
    await col(C_ALLOC).createIndex({ event_id: 1, item_id: 1, store: 1 }, { unique: true });
    await col(C_USAGE).createIndex({ event_id: 1, store: 1, date: -1 });
    await col(C_USAGE).createIndex({ event_id: 1, item_id: 1, store: 1, date: 1 }, { unique: true, name: 'daily_unique' });
    await col(C_LINKS).createIndex({ store: 1 }, { unique: true });
    await col(C_LINKS).createIndex({ token: 1 }, { unique: true });
}

const col = name => mongoClient.db(DB_NAME).collection(name);

// ---------- 유틸 ----------
function todayKST() {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toObjectId = s => (typeof s === 'string' && /^[0-9a-f]{24}$/i.test(s)) ? new ObjectId(s) : null;
function toInt(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
}
const cleanText = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newItemId = () => `it_${crypto.randomBytes(5).toString('hex')}`;
const newLinkToken = () => `pz_${crypto.randomBytes(12).toString('base64url')}`;
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const koSort = (a, b) => a.localeCompare(b, 'ko');

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
    const map = {}; // map[store][item_id] = { allocated, used, usable(null=할당과 같음) }
    const cell = (s, i) => {
        if (!map[s]) map[s] = {};
        if (!map[s][i]) map[s][i] = { allocated: 0, used: 0, usable: null };
        return map[s][i];
    };
    allocs.forEach(a => {
        const c = cell(a.store, a.item_id);
        c.allocated = a.qty || 0;
        c.usable = typeof a.usable === 'number' ? a.usable : null;
    });
    usedAgg.forEach(u => { cell(u._id.store, u._id.item_id).used = u.used || 0; });
    return map;
}

// 운영 매장 — 통합관리시스템과 같은 기준 (ON 직원 1명 이상, 팝업·매니저영업 제외)
const storeNameOk = s => s && !String(s).includes('팝업') && !String(s).includes('매니저영업');
async function operatingStores() {
    const names = await mongoClient.db(STAFF_DB_NAME).collection('jwasu_managers')
        .distinct('storeName', { isActive: { $ne: false }, isHidden: { $ne: true } });
    return names.filter(storeNameOk).sort(koSort);
}
// 통합관리시스템에 등록된 모든 매장 (오픈 전·직원 OFF 매장 포함) — 본사 [매장 추가] 목록
async function registeredStores() {
    const names = await mongoClient.db(STAFF_DB_NAME).collection('jwasu_managers').distinct('storeName');
    return names.filter(storeNameOk).sort(koSort);
}
// 활용 가능 수량 — 따로 안 정했으면 할당 수량과 같다
const effUsable = c => (typeof c.usable === 'number' ? c.usable : c.allocated);

async function storeFromToken(token) {
    if (!token || typeof token !== 'string' || token.length > 80) return null;
    const doc = await col(C_LINKS).findOne({ token });
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
        list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1)); // 진행중 먼저
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
        // 경품 이름을 바꾸면 기록에 남겨 둔 이름도 맞춘다
        for (const it of parsed.value.items) {
            const before = (ev.items || []).find(x => x.id === it.id);
            if (before && before.name !== it.name) {
                await col(C_USAGE).updateMany({ event_id: eventId, item_id: it.id }, { $set: { item_name: it.name } });
            }
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
//   stores = 운영 매장 + (운영은 안 하지만 이미 할당·사용 기록이 있는 매장)
router.get('/api/prize/admin/events/:id/summary', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const eventId = String(ev._id);
        const [map, operating, links, registered] = await Promise.all([
            loadTotals(eventId),
            operatingStores(),
            col(C_LINKS).distinct('store'),
            registeredStores(),
        ]);
        const opSet = new Set(operating);
        const linkSet = new Set(links);
        const stores = [...new Set([...operating, ...Object.keys(map)])].sort(koSort);
        const items = ev.items || [];
        // remaining = 할당 − 사용 / usable = 실제 활용 가능 수량(안 정했으면 할당과 같음) / usable_remaining = 활용 가능 − 사용
        const zero = () => ({ allocated: 0, used: 0, remaining: 0, usable: 0, usable_remaining: 0 });
        const add = (t, c) => { for (const k of Object.keys(t)) t[k] += c[k]; };

        const itemTotals = {};
        items.forEach(it => { itemTotals[it.id] = zero(); });
        const grand = zero();

        const rows = stores.map(store => {
            const cells = {};
            const total = zero();
            items.forEach(it => {
                const c = map[store]?.[it.id] || { allocated: 0, used: 0, usable: null };
                const usable = effUsable(c);
                const cell = { allocated: c.allocated, used: c.used, remaining: c.allocated - c.used, usable, usable_remaining: usable - c.used };
                cells[it.id] = { ...cell, usable_set: typeof c.usable === 'number' };
                add(total, cell);
                add(itemTotals[it.id], cell);
            });
            add(grand, total);
            return { store, operating: opSet.has(store), has_link: linkSet.has(store), cells, total };
        });
        const addable = registered.filter(s => !stores.includes(s));

        res.json({ success: true, today: todayKST(), event: publicEvent(ev), stores, rows, itemTotals, grand, addable });
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

        // 한 줄 = { store, item_id, qty?, usable? } — qty(할당)·usable(실제 활용 가능, null=할당과 같음) 중 보낸 것만 바꾼다
        const clean = [];
        for (const a of list) {
            const store = cleanText(a?.store, 60);
            if (!store) return fail(res, 400, '매장명이 비어 있는 줄이 있습니다.');
            if (!itemName[a?.item_id]) return fail(res, 400, '이벤트에 없는 경품이 들어왔습니다. 새로고침 후 다시 시도해 주세요.');
            const label = `${store} · ${itemName[a.item_id]}`;
            const hasQty = a.qty !== undefined, hasUsable = a.usable !== undefined;
            if (!hasQty && !hasUsable) return fail(res, 400, `${label}: 바꿀 수량이 없습니다.`);
            const entry = { store, item_id: a.item_id };
            if (hasQty) {
                const qty = toInt(a.qty);
                if (qty === null || qty < 0 || qty > MAX_QTY) return fail(res, 400, `${label}: 할당 수량은 0~${MAX_QTY} 사이 정수로 입력해 주세요.`);
                entry.qty = qty;
            }
            if (hasUsable) {
                if (a.usable === null || a.usable === '') entry.usable = null;
                else {
                    const u = toInt(a.usable);
                    if (u === null || u < 0 || u > MAX_QTY) return fail(res, 400, `${label}: 활용 가능 수량은 0 이상 정수로 입력해 주세요.`);
                    entry.usable = u;
                }
            }
            clean.push(entry);
        }

        const map = await loadTotals(eventId);
        const errors = [];
        const merged = clean.map(a => {
            const cur = map[a.store]?.[a.item_id] || { allocated: 0, used: 0, usable: null };
            const qty = a.qty !== undefined ? a.qty : cur.allocated;
            const usable = a.usable !== undefined ? a.usable : cur.usable;
            const label = `${a.store} · ${itemName[a.item_id]}`;
            if (cur.used > qty) errors.push(`${label}: 이미 ${cur.used}개 사용해서 할당을 ${qty}개로 줄일 수 없습니다`);
            if (qty > 0 && usable !== null && usable > qty) errors.push(`${label}: 활용 가능 수량(${usable})이 할당 수량(${qty})보다 많습니다`);
            return { store: a.store, item_id: a.item_id, qty, usable };
        });
        if (errors.length) return fail(res, 400, `저장하지 못했습니다:\n${errors.slice(0, 10).join('\n')}`);

        const now = new Date();
        const ops = merged.map(a => {
            const filter = { event_id: eventId, item_id: a.item_id, store: a.store };
            return a.qty === 0
                ? { deleteOne: { filter } }
                : { updateOne: { filter, update: { $set: { qty: a.qty, usable: a.usable, updated_at: now }, $setOnInsert: { created_at: now } }, upsert: true } };
        });
        await col(C_ALLOC).bulkWrite(ops, { ordered: false });
        await col(C_EVENTS).updateOne({ _id: ev._id }, { $set: { updated_at: now } });
        res.json({ success: true, saved: clean.length });
    } catch (e) {
        console.error('[prize] 할당 저장 실패:', e);
        fail(res, 500, '할당 수량을 저장하지 못했습니다.');
    }
});

// 사용 기록 (전체 또는 매장 하나) — 한 줄 = 한 매장·한 경품·하루
router.get('/api/prize/admin/events/:id/usage', async (req, res) => {
    try {
        const ev = await findEvent(req.params.id);
        if (!ev) return fail(res, 404, '이벤트를 찾을 수 없습니다.');
        const q = { event_id: String(ev._id) };
        if (req.query.store) q.store = String(req.query.store);
        const logs = await col(C_USAGE).find(q).sort({ date: -1, store: 1 }).limit(5000).toArray();
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

// 매장별 경품 전용 링크 목록 + 운영 매장
router.get('/api/prize/admin/links', async (req, res) => {
    try {
        const [links, operating] = await Promise.all([
            col(C_LINKS).find({}).sort({ store: 1 }).toArray(),
            operatingStores(),
        ]);
        res.json({
            success: true,
            operating,
            links: links.map(l => ({ store: l.store, token: l.token, created_at: l.created_at })),
        });
    } catch (e) {
        console.error('[prize] 링크 목록 실패:', e);
        fail(res, 500, '매장 링크를 불러오지 못했습니다.');
    }
});

// 링크 만들기 / 다시 만들기 — body { store, regenerate } (다시 만들면 예전 링크는 바로 끊긴다)
router.post('/api/prize/admin/links', async (req, res) => {
    try {
        const store = cleanText(req.body?.store, 60);
        if (!store) return fail(res, 400, '매장을 선택해 주세요.');
        const regenerate = req.body?.regenerate === true;
        const operating = await operatingStores();
        const hasData = await col(C_ALLOC).countDocuments({ store }, { limit: 1 });
        if (!operating.includes(store) && !hasData) return fail(res, 400, '운영 중인 매장이 아닙니다. 통합관리시스템에서 매장·직원 상태를 확인해 주세요.');

        const existing = await col(C_LINKS).findOne({ store });
        if (existing && !regenerate) return res.json({ success: true, link: { store, token: existing.token, created_at: existing.created_at } });

        const token = newLinkToken();
        const now = new Date();
        await col(C_LINKS).updateOne({ store }, { $set: { token, created_at: now } }, { upsert: true });
        res.json({ success: true, link: { store, token, created_at: now }, regenerated: !!existing });
    } catch (e) {
        console.error('[prize] 링크 만들기 실패:', e);
        fail(res, 500, '매장 링크를 만들지 못했습니다.');
    }
});

// ==========================================
// 매장 스태프 관리 페이지(매장매니저관리프로그램 = /off/staff/index.html?key=주간보고 매장 키)용
//   [이벤트 > 경품 재고 관리] 메뉴를 띄울지와 열 경품 링크를 돌려준다.
//   우리 매장에 보이는(노출 시작일 지난 진행중) 이벤트에 할당이 있을 때만 링크를 준다 — 없으면 만들어서.
// ==========================================
router.get('/api/prize/hub/:storeToken', async (req, res) => {
    try {
        const t = String(req.params.storeToken || '');
        if (!t || t.length > 80) return fail(res, 404, '매장 링크가 올바르지 않습니다.');
        const st = await col('store_tokens').findOne({ token: t });
        if (!st?.store) return fail(res, 404, '매장 링크가 올바르지 않습니다.');
        const store = st.store;
        const today = todayKST();
        const events = (await col(C_EVENTS).find({ status: 'active' }).toArray()).filter(ev => isVisibleToStore(ev, today));
        let count = 0;
        for (const ev of events) {
            if (await col(C_ALLOC).countDocuments({ event_id: String(ev._id), store, qty: { $gt: 0 } }, { limit: 1 })) count++;
        }
        if (!count) return res.json({ success: true, store, events: 0, token: null });
        let link = await col(C_LINKS).findOne({ store });
        if (!link) {
            await col(C_LINKS).updateOne({ store }, { $setOnInsert: { token: newLinkToken(), created_at: new Date() } }, { upsert: true });
            link = await col(C_LINKS).findOne({ store });
        }
        res.json({ success: true, store, events: count, token: link.token });
    } catch (e) {
        console.error('[prize] 스태프 페이지 링크 실패:', e);
        fail(res, 500, '경품 정보를 불러오지 못했습니다.');
    }
});

// ==========================================
// 매장 API — 경품 전용 링크의 key(prize_links.token)로 매장을 확인한다.
// 매장명은 토큰에서만 읽어서 다른 매장 데이터를 건드릴 수 없다.
// ==========================================

// 우리 매장에 보이는 이벤트·경품
router.get('/api/prize/store/:token', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '링크가 올바르지 않습니다. 본사에 새 링크를 요청해 주세요.');
        const today = todayKST();
        const events = (await col(C_EVENTS).find({ status: 'active' }).sort({ created_at: -1 }).toArray())
            .filter(ev => isVisibleToStore(ev, today));

        const out = [];
        for (const ev of events) {
            const map = await loadTotals(String(ev._id), store);
            const items = (ev.items || [])
                .map(it => {
                    const c = map[store]?.[it.id] || { allocated: 0, used: 0, usable: null };
                    const usable = effUsable(c);
                    return {
                        id: it.id, name: it.name, allocated: c.allocated, used: c.used, remaining: c.allocated - c.used,
                        usable, usable_set: typeof c.usable === 'number', usable_remaining: usable - c.used,
                    };
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

// 우리 매장 날짜별 기록
router.get('/api/prize/store/:token/usage', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '링크가 올바르지 않습니다. 본사에 새 링크를 요청해 주세요.');
        const q = { store };
        if (req.query.event_id) q.event_id = String(req.query.event_id);
        const logs = await col(C_USAGE).find(q).sort({ date: -1 }).limit(2000).toArray();
        res.json({ success: true, logs: logs.map(l => ({ _id: String(l._id), event_id: l.event_id, item_id: l.item_id, item_name: l.item_name, date: l.date, qty: l.qty })) });
    } catch (e) {
        console.error('[prize] 매장 사용 기록 조회 실패:', e);
        fail(res, 500, '사용 기록을 불러오지 못했습니다.');
    }
});

// 그날 나간 수량 저장 — body { event_id, date, counts: { item_id: qty } }
//   경품마다 그날 한 칸. 같은 날 다시 저장하면 덮어쓴다(0 이면 그날 기록 지움).
router.put('/api/prize/store/:token/daily', async (req, res) => {
    try {
        const store = await storeFromToken(req.params.token);
        if (!store) return fail(res, 404, '링크가 올바르지 않습니다. 본사에 새 링크를 요청해 주세요.');
        const today = todayKST();

        const ev = await findEvent(req.body?.event_id);
        if (!ev || !isVisibleToStore(ev, today)) return fail(res, 400, '지금 입력할 수 있는 이벤트가 아닙니다. 새로고침해 주세요.');
        const eventId = String(ev._id);
        const visibleFrom = ev.visible_from || DEFAULT_VISIBLE_FROM;

        const date = String(req.body?.date || today);
        if (!isDate(date)) return fail(res, 400, '날짜를 확인해 주세요.');
        if (date > today) return fail(res, 400, '오늘 이후 날짜는 입력할 수 없습니다.');
        if (date < visibleFrom) return fail(res, 400, `${visibleFrom} 이전 날짜는 입력할 수 없습니다.`);

        const counts = req.body?.counts && typeof req.body.counts === 'object' ? req.body.counts : {};
        const itemsById = Object.fromEntries((ev.items || []).map(it => [it.id, it]));
        const entries = [];
        for (const [itemId, raw] of Object.entries(counts)) {
            const item = itemsById[itemId];
            if (!item) return fail(res, 400, '이벤트에 없는 경품이 들어왔습니다. 새로고침해 주세요.');
            const qty = toInt(raw);
            if (qty === null || qty < 0 || qty > MAX_QTY) return fail(res, 400, `${item.name}: 수량은 0 이상 정수로 넣어 주세요.`);
            entries.push({ item, qty });
        }
        if (!entries.length) return fail(res, 400, '저장할 수량이 없습니다.');

        const map = await loadTotals(eventId, store);
        const dayDocs = await col(C_USAGE).find({ event_id: eventId, store, date, item_id: { $in: entries.map(e => e.item.id) } }).toArray();
        const dayQty = {};
        dayDocs.forEach(d => { dayQty[d.item_id] = (dayQty[d.item_id] || 0) + (d.qty || 0); });

        for (const { item, qty } of entries) {
            const c = map[store]?.[item.id] || { allocated: 0, used: 0 };
            const otherDays = c.used - (dayQty[item.id] || 0);
            if (qty > 0 && c.allocated <= 0) return fail(res, 400, `${item.name}: 우리 매장에 할당되지 않은 경품입니다.`);
            if (otherDays + qty > c.allocated) return fail(res, 400, `${item.name}: 남은 수량(${c.allocated - otherDays}개)보다 많이 넣을 수 없습니다.`);
        }

        const now = new Date();
        for (const { item, qty } of entries) {
            const filter = { event_id: eventId, item_id: item.id, store, date };
            if (qty === 0) {
                await col(C_USAGE).deleteMany(filter);
            } else {
                await col(C_USAGE).updateOne(filter,
                    { $set: { qty, item_name: item.name, updated_at: now }, $setOnInsert: { created_at: now } },
                    { upsert: true });
            }
        }

        // 다른 기기에서 동시에 저장해 할당을 넘었으면 이번 저장을 되돌린다
        const after = await loadTotals(eventId, store);
        const over = entries.filter(({ item }) => (after[store]?.[item.id]?.used || 0) > (after[store]?.[item.id]?.allocated || 0));
        if (over.length) {
            for (const { item } of over) {
                const filter = { event_id: eventId, item_id: item.id, store, date };
                await col(C_USAGE).deleteMany(filter);
                const prev = dayDocs.filter(d => d.item_id === item.id);
                if (prev.length) await col(C_USAGE).insertMany(prev);
            }
            return fail(res, 409, '방금 다른 곳에서 입력이 들어와 남은 수량이 바뀌었습니다. 새로고침 후 다시 저장해 주세요.');
        }
        res.json({ success: true, date, saved: entries.length });
    } catch (e) {
        if (e && e.code === 11000) return fail(res, 409, '다른 곳에서 같은 날을 동시에 저장했습니다. 새로고침 후 다시 저장해 주세요.');
        console.error('[prize] 하루 수량 저장 실패:', e);
        fail(res, 500, '수량을 저장하지 못했습니다.');
    }
});

module.exports = { router, init };
