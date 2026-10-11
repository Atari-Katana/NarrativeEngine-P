// Player Journal — everything the GM can be told.
//
// The journal is PRIVATE by default. Only three paths carry it to a model, and
// each one has its own framing so the model knows who knows what:
//
//   1. Remind GM   — one turn, out of character. The GM learns what the player
//                    is tracking; no character in the story does.
//   2. Show in scene — one turn, in character. The pages are shown / read
//                    aloud / read by someone present, so the characters who
//                    see them now know. The GM's narration of that moment is
//                    what carries it into history and memory from then on.
//   3. Ask GM      — the out-of-character Q&A channel. The GM, as GM, can see
//                    open to-dos and the entries a question names. Entries the
//                    player locked are left out of this path entirely.
//
// Pure functions. `index.js` feeds them the mod's state.

import { openTasks, resolveMentions } from './markdown.js';

/** Hard cap on one entry's body in a prompt block, before the host's own
 *  token budget trims the block. Keeps one huge entry from crowding out the
 *  others when several are armed at once. */
export const MAX_ENTRY_CHARS = 2400;

/** Most entries that may be armed for one turn. */
export const MAX_ARMED = 3;

/**
 * A resolver for one entry: label → current display name, or null when the
 * record it pointed at is gone.
 *
 * `world` is `{ npcs: Map<id, {name}>, places: Map<id, {name}>, pc: {id, name} | null }`.
 */
export function makeResolver(refs, world) {
    return (label) => {
        const ref = refs?.[label];
        if (!ref) return null;
        if (ref.kind === 'npc') return world.npcs.get(ref.id)?.name ?? null;
        if (ref.kind === 'place') return world.places.get(ref.id)?.name ?? null;
        if (ref.kind === 'pc') return world.pc && world.pc.id === ref.id ? world.pc.name : null;
        return null;
    };
}

/** "Day 12, Sector 4" — the in-world half of an entry's stamp, or ''. */
export function worldStamp(stamp) {
    const bits = [];
    if (stamp && Number.isFinite(stamp.day)) bits.push(`Day ${stamp.day}`);
    if (stamp && stamp.place) bits.push(stamp.place);
    return bits.join(', ');
}

function clip(text, max) {
    const s = String(text ?? '').trim();
    return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

function entryText(entry, world) {
    const title = String(entry.title ?? '').trim() || 'Untitled';
    const where = worldStamp(entry.stamp);
    const body = resolveMentions(clip(entry.body, MAX_ENTRY_CHARS), makeResolver(entry.refs, world));
    return [`## ${title}${where ? ` (${where})` : ''}`, body || '(empty page)'].join('\n');
}

const REMIND_HEADER = [
    '[PLAYER JOURNAL: OUT OF CHARACTER, THIS TURN ONLY]',
    "The player is showing you, the GM, notes from their character's private journal so you understand what they are tracking and intending.",
    'No one in the story knows these notes exist or what they say. No character may quote, reference, or react to them unless the player character reveals the information in play.',
    "Use them to understand the player's intent. Do not resolve their goals for them.",
].join('\n');

const SHOW_HEADER = [
    '[PLAYER JOURNAL: SHOWN IN THE SCENE THIS TURN]',
    "In the story, these pages of the player character's journal are being shown, read aloud, or read by someone present. The player's message says how.",
    'Every character who sees or hears them now knows what is written. Reflect that in the narration.',
].join('\n');

const FOOTER = '[END PLAYER JOURNAL]';

/**
 * The contributions for this turn, one per mode that has armed entries.
 * `armed` is `[{ entryId, mode: 'remind' | 'show' }]`. Entries that no longer
 * exist are skipped. Returns `[]` when nothing is armed.
 */
export function buildArmedContributions(armed, entries, world) {
    const byId = new Map((entries ?? []).map((e) => [e.id, e]));
    const pick = (mode) => (armed ?? [])
        .filter((a) => a.mode === mode)
        .map((a) => byId.get(a.entryId))
        .filter(Boolean)
        .slice(0, MAX_ARMED);

    const out = [];
    const remind = pick('remind');
    if (remind.length) {
        out.push({
            id: 'journalRemind',
            order: 650,
            budget: 900,
            text: [REMIND_HEADER, ...remind.map((e) => entryText(e, world)), FOOTER].join('\n\n'),
        });
    }
    const show = pick('show');
    if (show.length) {
        out.push({
            id: 'journalShow',
            order: 660,
            budget: 900,
            text: [SHOW_HEADER, ...show.map((e) => entryText(e, world)), FOOTER].join('\n\n'),
        });
    }
    return out;
}

const MAX_OOC_TASKS = 8;
const MAX_OOC_MATCHES = 3;
const MAX_OOC_TITLES = 5;

/**
 * The Ask-GM section: the GM, as GM, reading the journal. Locked entries are
 * never read here. Open to-dos always; full text only for the entries the
 * question names (by title or by a mentioned name); otherwise the recent
 * titles, so "what was I doing?" has something to answer from.
 *
 * `c` is the host's `{ question, excerpt, namedIn }`.
 */
export function buildOocSection(c, entries, world) {
    const shared = (entries ?? []).filter((e) => !e.private);
    if (shared.length === 0) return null;

    const lines = ["Player journal (the player's own notes; characters in the story do not know them):"];
    const sources = [];

    const tasks = [];
    for (const e of shared) {
        const resolve = makeResolver(e.refs, world);
        for (const t of openTasks(e.body)) {
            if (tasks.length >= MAX_OOC_TASKS) break;
            tasks.push(resolveMentions(t, resolve));
        }
    }
    if (tasks.length) {
        lines.push('Open to-dos:');
        for (const t of tasks) lines.push(`- ${c.excerpt(t, 160)}`);
    }

    const question = String(c.question ?? '');
    const named = shared.filter((e) => {
        const title = String(e.title ?? '').trim();
        if (title.length >= 3 && c.namedIn(question, title)) return true;
        const resolve = makeResolver(e.refs, world);
        return Object.keys(e.refs ?? {}).some((label) => {
            const name = resolve(label) ?? label;
            return name.length >= 3 && c.namedIn(question, name);
        });
    }).slice(0, MAX_OOC_MATCHES);

    if (named.length) {
        lines.push('Entries this question names:');
        for (const e of named) {
            const text = c.excerpt(resolveMentions(e.body, makeResolver(e.refs, world)).replace(/\s+/g, ' '), 400);
            const where = worldStamp(e.stamp);
            const line = `"${e.title || 'Untitled'}"${where ? ` (${where})` : ''}: ${text}`;
            lines.push(`- ${line}`);
            sources.push({ kind: 'journal', id: e.id, label: `Journal: ${e.title || 'Untitled'}`, excerpt: c.excerpt(line, 500) });
        }
    } else {
        const recent = [...shared].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, MAX_OOC_TITLES);
        lines.push(`Recent entries: ${recent.map((e) => `"${c.excerpt(e.title || 'Untitled', 60)}"`).join(', ')}`);
    }

    return { lines, sources };
}
