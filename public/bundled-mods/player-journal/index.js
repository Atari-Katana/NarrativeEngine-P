// Player Journal — a private, player-written journal.
//
// Written against docs/MODDING.md and docs/narrative-mod-api.d.ts only. A mod
// never imports from `src/`.
//
// What it does:
//   - A floating Journal window: entries in Markdown with checkboxes, a small
//     toolbar, and `@` links to NPCs, places and the player character.
//   - Remind GM / Show in scene: arm an entry and it rides along with the next
//     message, once (prompt.js has the framing for each).
//   - Ask GM can read the journal as the GM, never as a character. Entries the
//     player marks Private are skipped.
//
// The journal never writes itself and never reaches the story prompt unless
// the player arms an entry.
//
// Surfaces: window.layer, header.actions (launcher), composer.actions (pill),
// own tables, ctx.subscribe, the event bus, the pre-prompt interceptor, and
// ctx.oocSections.

import { buildArmedContributions, buildOocSection, MAX_ARMED } from './prompt.js';
import { mountJournal } from './editor.js';

const ENTRIES = 'entries';
const META = 'meta';

const state = {
    campaignId: null,
    entries: [],
    meta: { armed: [], lastOpenId: null },
    npcs: [],
    places: [],
    location: { currentPlaceId: null, worldDay: undefined },
    pc: null,
    onStage: [],
};

let live = null;              // the freshest ModContext; writes go through it
let campaignUnsubs = [];      // subscriptions for the open campaign only
let bindSeq = 0;              // drops a stale bind when campaigns switch fast
let consumed = null;          // { turnId, armed } taken by the last interception
const listeners = new Set();
let headerHandle = null;
let composerHandle = null;
let win = null;

// ─── State ─────────────────────────────────────────────────────────────────

function notify() {
    headerHandle?.update();
    composerHandle?.update();
    for (const fn of [...listeners]) {
        try { fn(); } catch (err) { live?.log('journal listener failed:', err); }
    }
}

function makeId() {
    return globalThis.crypto?.randomUUID?.() ?? `pj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tables are user-editable files. Anything malformed is repaired, not trusted. */
export function repairEntries(rows) {
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
        seen.add(r.id);
        const refs = {};
        if (r.refs && typeof r.refs === 'object' && !Array.isArray(r.refs)) {
            for (const [label, ref] of Object.entries(r.refs)) {
                if (ref && typeof ref.id === 'string' && ['npc', 'place', 'pc'].includes(ref.kind)) {
                    refs[label] = { kind: ref.kind, id: ref.id };
                }
            }
        }
        const stamp = r.stamp && typeof r.stamp === 'object' ? r.stamp : {};
        out.push({
            id: r.id,
            title: typeof r.title === 'string' ? r.title : '',
            body: typeof r.body === 'string' ? r.body : '',
            refs,
            private: r.private === true,
            createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
            updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : (Number.isFinite(r.createdAt) ? r.createdAt : Date.now()),
            stamp: {
                day: Number.isFinite(stamp.day) ? stamp.day : null,
                place: typeof stamp.place === 'string' && stamp.place ? stamp.place : null,
            },
        });
    }
    return out;
}

export function repairMeta(row) {
    const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const armed = Array.isArray(r.armed)
        ? r.armed.filter((a) => a && typeof a.entryId === 'string' && (a.mode === 'remind' || a.mode === 'show')).slice(0, MAX_ARMED)
        : [];
    return { armed, lastOpenId: typeof r.lastOpenId === 'string' ? r.lastOpenId : null };
}

function world() {
    return {
        npcs: new Map(state.npcs.map((n) => [n.id, n])),
        places: new Map(state.places.map((p) => [p.id, p])),
        pc: state.pc && state.pc.id ? { id: state.pc.id, name: state.pc.name } : null,
    };
}

function persist(table, value) {
    if (!live || !state.campaignId) return;
    live.table.write(table, value).catch((err) => live?.log(`journal: ${table} write failed:`, err));
}

function setEntries(entries) {
    state.entries = entries;
    persist(ENTRIES, entries);
    notify();
}

function setMeta(meta) {
    state.meta = meta;
    persist(META, meta);
    notify();
}

/** "Where and when am I" at the moment an entry is created. */
function stampNow() {
    const place = state.places.find((p) => p.id === state.location.currentPlaceId);
    return {
        day: Number.isFinite(state.location.worldDay) ? state.location.worldDay : null,
        place: place ? place.name : null,
    };
}

/** Mention candidates, best-first for an empty query: you, who is here,
 *  where you are, then everyone and everywhere else. */
function candidates() {
    const out = [];
    if (state.pc && state.pc.id && state.pc.name) out.push({ kind: 'pc', id: state.pc.id, name: state.pc.name, hint: 'Your character' });
    const onStage = new Set(state.onStage);
    const npcs = state.npcs.filter((n) => !n.isPC && !n.archived && n.name);
    const npcHint = (n) => [n.faction, n.storyRelevance].filter((s) => s && String(s).trim()).join(' · ').slice(0, 60);
    for (const n of npcs.filter((x) => onStage.has(x.id))) out.push({ kind: 'npc', id: n.id, name: n.name, aliases: n.aliases, hint: npcHint(n) || 'Here now' });
    const here = state.places.find((p) => p.id === state.location.currentPlaceId);
    if (here) out.push({ kind: 'place', id: here.id, name: here.name, hint: 'You are here' });
    for (const n of npcs.filter((x) => !onStage.has(x.id))) out.push({ kind: 'npc', id: n.id, name: n.name, aliases: n.aliases, hint: npcHint(n) });
    for (const p of state.places.filter((x) => x.id !== here?.id && x.name)) out.push({ kind: 'place', id: p.id, name: p.name, hint: p.broadLocation || '' });
    return out;
}

const api = {
    getState: () => ({ campaignId: state.campaignId, entries: state.entries, meta: state.meta }),
    world,
    candidates,
    subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
    createEntry() {
        if (!state.campaignId) return null;
        const now = Date.now();
        const entry = { id: makeId(), title: '', body: '', refs: {}, private: false, createdAt: now, updatedAt: now, stamp: stampNow() };
        setEntries([entry, ...state.entries]);
        return entry;
    },
    updateEntry(id, patch) {
        let changed = false;
        const next = state.entries.map((e) => {
            if (e.id !== id) return e;
            const merged = { ...e, ...patch };
            if (['title', 'body', 'refs', 'private'].every((k) => JSON.stringify(merged[k]) === JSON.stringify(e[k]))) return e;
            changed = true;
            return { ...merged, updatedAt: Date.now() };
        });
        if (changed) setEntries(next);
    },
    deleteEntry(id) {
        setEntries(state.entries.filter((e) => e.id !== id));
        const armed = state.meta.armed.filter((a) => a.entryId !== id);
        if (armed.length !== state.meta.armed.length || state.meta.lastOpenId === id) {
            setMeta({ ...state.meta, armed, lastOpenId: state.meta.lastOpenId === id ? null : state.meta.lastOpenId });
        }
    },
    /** Arm `mode` for an entry, or disarm it when it is already armed that way.
     *  One mode per entry. False when the cap is reached. */
    toggleArm(id, mode) {
        const existing = state.meta.armed.find((a) => a.entryId === id);
        const rest = state.meta.armed.filter((a) => a.entryId !== id);
        if (existing && existing.mode === mode) {
            setMeta({ ...state.meta, armed: rest });
            return true;
        }
        if (!existing && rest.length >= MAX_ARMED) return false;
        setMeta({ ...state.meta, armed: [...rest, { entryId: id, mode }] });
        return true;
    },
    setLastOpen(id) {
        if (state.meta.lastOpenId === id) return;
        // Not worth a notify: nothing on screen depends on it.
        state.meta = { ...state.meta, lastOpenId: id };
        persist(META, state.meta);
    },
};

// ─── Campaign binding ──────────────────────────────────────────────────────
//
// The host revokes every subscription when the campaign changes, so they are
// rebuilt on each `campaign.opened` (sticky, so a late activate still sees the
// open campaign). Each campaign has its own tables; nothing carries over.

function unbindCampaign() {
    for (const stop of campaignUnsubs) {
        try { stop(); } catch { /* already revoked */ }
    }
    campaignUnsubs = [];
}

function resetState(campaignId) {
    state.campaignId = campaignId;
    state.entries = [];
    state.meta = { armed: [], lastOpenId: null };
    state.npcs = [];
    state.places = [];
    state.location = { currentPlaceId: null, worldDay: undefined };
    state.pc = null;
    state.onStage = [];
    consumed = null;
}

function readWorld(data) {
    state.npcs = Array.isArray(data.npcLedger) ? data.npcLedger : [];
    state.places = Array.isArray(data.location?.ledger) ? data.location.ledger : [];
    state.location = { currentPlaceId: data.location?.currentPlaceId ?? null, worldDay: data.location?.worldDay };
    state.pc = data.playerCharacter ?? null;
    state.onStage = Array.isArray(data.onStageNpcIds) ? data.onStageNpcIds : [];
}

async function bindCampaign(ctx, campaignId) {
    const seq = ++bindSeq;
    unbindCampaign();
    let fresh;
    try {
        fresh = await ctx.refresh();
    } catch (err) {
        ctx.log('journal: refresh failed:', err);
        return;
    }
    if (seq !== bindSeq) return;
    live = fresh;
    const id = fresh.data.campaignId ?? campaignId ?? null;
    resetState(id);
    if (!id) { notify(); return; }
    readWorld(fresh.data);

    const watch = (subscribe) => {
        try {
            const stop = subscribe();
            if (typeof stop === 'function') campaignUnsubs.push(stop);
        } catch (err) {
            fresh.log('journal: subscription unavailable:', err);
        }
    };
    // No `table.subscribe` for the journal's own tables. The host fills mod
    // tables in the same store update that fires `campaign.opened`, so the
    // read below is complete, and only this mod writes these tables, so after
    // it the local state is the truth. A table subscription here would only
    // echo our own writes back, and the host can deliver the PREVIOUS value
    // first (its per-lease table cache updates after the store does), which
    // overwrote entries mid-edit and lost what the player had typed.
    watch(() => fresh.subscribe('npcLedger', (v) => { state.npcs = Array.isArray(v) ? v : []; notify(); }));
    watch(() => fresh.subscribe('location', (v) => {
        state.places = Array.isArray(v?.ledger) ? v.ledger : [];
        state.location = { currentPlaceId: v?.currentPlaceId ?? null, worldDay: v?.worldDay };
    }));
    watch(() => fresh.subscribe('playerCharacter', (v) => { state.pc = v ?? null; }));
    watch(() => fresh.subscribe('onStageNpcIds', (v) => { state.onStage = Array.isArray(v) ? v : []; }));

    try {
        const [rows, meta] = await Promise.all([fresh.table.read(ENTRIES), fresh.table.read(META)]);
        if (seq !== bindSeq) return;
        state.entries = repairEntries(rows);
        state.meta = repairMeta(meta);
    } catch (err) {
        // Without a successful read, a write would replace whatever is on
        // disk with a near-empty journal. Stay unbound instead: the window
        // shows "open a campaign", and the next `campaign.opened` retries.
        fresh.log('journal: initial read failed:', err);
        if (seq === bindSeq) resetState(null);
    }
    notify();
}

// ─── The pre-prompt interceptor ────────────────────────────────────────────

/**
 * Adds armed entries to this turn's prompt. Fires once per turn; swipes and
 * continuations reuse its output, so the entries are disarmed when the turn's
 * reply has been generated, not here: a turn that fails keeps them armed.
 */
export function interceptPrompt(input) {
    if (!state.campaignId || (input?.campaignId && input.campaignId !== state.campaignId)) return;
    if (!state.meta.armed.length) return;
    const contributions = buildArmedContributions(state.meta.armed, state.entries, world());
    if (!contributions.length) return;
    consumed = { turnId: input?.turnId ?? null, armed: state.meta.armed.map((a) => ({ ...a })) };
    return { contributions };
}

function onTurnGenerated(payload) {
    if (!consumed || !payload || payload.turnId !== consumed.turnId) return;
    if (payload.campaignId && payload.campaignId !== state.campaignId) return;
    const sent = consumed.armed;
    consumed = null;
    const armed = state.meta.armed.filter((a) => !sent.some((s) => s.entryId === a.entryId && s.mode === a.mode));
    if (armed.length !== state.meta.armed.length) setMeta({ ...state.meta, armed });
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export function onActivate(ctx) {
    if (!ctx || !ctx.mounts) return;
    live = ctx;

    win = ctx.mounts.window({
        id: 'journal',
        title: 'Journal',
        defaultSize: { width: 860, height: 580 },
        minSize: { width: 560, height: 380 },
        resizable: true,
        mount: (node) => mountJournal(node, api),
    });

    headerHandle = ctx.mounts.header({
        id: 'open',
        icon: 'BookOpen',
        label: 'Journal',
        tooltip: 'Open your journal',
        onSelect: () => win?.open(),
    });

    composerHandle = ctx.mounts.composer({
        id: 'journal',
        icon: 'BookOpen',
        label: 'Journal',
        tooltip: 'Open your journal',
        onSelect: () => win?.open(),
        // The composer row renders `label` and `tone` but not `badge`, so the
        // armed count rides in the label.
        state: () => {
            const n = state.meta.armed.length;
            return n
                ? { label: `Journal · ${n}`, tone: 'active', tooltip: `${n} journal entr${n === 1 ? 'y goes' : 'ies go'} with your next message` }
                : { tooltip: 'Open your journal' };
        },
    });

    ctx.oocSections?.register({
        id: 'journal',
        order: 700,
        build: (c) => buildOocSection(c, state.entries, world()),
    });

    ctx.events.on('campaign.opened', (p) => { void bindCampaign(ctx, p?.campaignId); });
    ctx.events.on('campaign.closing', () => {
        bindSeq++;
        unbindCampaign();
        resetState(null);
        notify();
    });
    ctx.events.on('turn.generated', onTurnGenerated);
}

export function onDisable() {
    // The host removes mounts, subscriptions, listeners, the interceptor and
    // the Ask-GM section itself. This only drops module state so a re-enable
    // starts clean.
    bindSeq++;
    unbindCampaign();
    resetState(null);
    listeners.clear();
    headerHandle = null;
    composerHandle = null;
    win = null;
    live = null;
}
