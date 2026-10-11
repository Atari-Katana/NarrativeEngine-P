// Player Journal — the text format.
//
// An entry body is plain Markdown, a deliberately small subset of it:
// headings (#, ##, ###), bullets (- * +), numbered items (1.), task items
// (- [ ] / - [x]), quotes (>), rules (---), **bold**, *italic*, ~~strike~~,
// `code`, and one addition of our own — the mention, written `@[Kane]`.
//
// A mention's text is only its label. Which NPC / place / character the label
// points at lives beside the body in the entry's `refs` map, keyed by label,
// so the raw text stays readable while the link survives a rename: the ledger
// name is looked up by id at render time and the stored label is only the
// fallback.
//
// Pure functions only. No DOM here — `editor.js` turns the parsed blocks into
// nodes. That keeps every rule in this file testable without a browser.

/** How far back from the caret an `@` token may start. Names have spaces, so
 *  the query can span them, but not unboundedly. Same cap as the gallery's
 *  `@` picker so the two feel identical. */
export const MAX_MENTION_QUERY = 40;

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,})\s*$/;
const MENTION_RE = /@\[([^\]\n]{1,60})\]/g;

/**
 * Split a body into display blocks. Every block remembers the source line it
 * came from, so a click on a rendered checkbox can flip exactly that line.
 *
 * Lists are deliberately flat (one block per item, with an indent level)
 * rather than a nested tree: a journal list is short, and a flat list cannot
 * be mis-nested by a stray space.
 */
export function parseBlocks(body) {
    const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = null;
    const endPara = () => { para = null; };

    lines.forEach((raw, line) => {
        if (!raw.trim()) { endPara(); return; }

        const list = LIST_RE.exec(raw);
        if (list) {
            endPara();
            const marker = list[2];
            const ordered = /\d/.test(marker);
            blocks.push({
                type: 'item',
                line,
                indent: Math.min(4, Math.floor(list[1].replace(/\t/g, '  ').length / 2)),
                ordered,
                number: ordered ? marker.replace(/[.)]$/, '') : null,
                task: list[3] === undefined ? null : list[3] !== ' ',
                text: list[4],
            });
            return;
        }
        const heading = HEADING_RE.exec(raw);
        if (heading) {
            endPara();
            blocks.push({ type: 'heading', line, level: heading[1].length, text: heading[2] });
            return;
        }
        if (RULE_RE.test(raw)) {
            endPara();
            blocks.push({ type: 'rule', line });
            return;
        }
        const quote = QUOTE_RE.exec(raw);
        if (quote) {
            const last = blocks[blocks.length - 1];
            if (last && last.type === 'quote' && last.endLine === line - 1) {
                last.lines.push(quote[1]);
                last.endLine = line;
            } else {
                endPara();
                blocks.push({ type: 'quote', line, endLine: line, lines: [quote[1]] });
            }
            return;
        }
        if (para) {
            para.lines.push(raw.trim());
            return;
        }
        para = { type: 'para', line, lines: [raw.trim()] };
        blocks.push(para);
    });
    return blocks;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(~~[^~\n]+?~~)|(\*[^*\s](?:[^*\n]*?[^*\s])?\*)|(@\[[^\]\n]{1,60}\])/;

/**
 * Inline spans as a small tree: `{ t: 'text', v }`, `{ t: 'code', v }`,
 * `{ t: 'strong' | 'em' | 'del', c: [...] }`, `{ t: 'mention', label }`.
 * Anything that is not one of these is text — there is no HTML pass-through,
 * so nothing a player types can become markup.
 */
export function parseInline(text) {
    const out = [];
    let rest = String(text ?? '');
    while (rest) {
        const m = INLINE_RE.exec(rest);
        if (!m) { out.push({ t: 'text', v: rest }); break; }
        if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) });
        const token = m[0];
        if (m[1]) out.push({ t: 'code', v: token.slice(1, -1) });
        else if (m[2]) out.push({ t: 'strong', c: parseInline(token.slice(2, -2)) });
        else if (m[3]) out.push({ t: 'del', c: parseInline(token.slice(2, -2)) });
        else if (m[4]) out.push({ t: 'em', c: parseInline(token.slice(1, -1)) });
        else out.push({ t: 'mention', label: token.slice(2, -1) });
        rest = rest.slice(m.index + token.length);
    }
    return out;
}

/** Flip the task on `line`. Any other line, or a line that is not a task, is
 *  returned untouched. */
export function toggleTask(body, line) {
    const lines = String(body ?? '').split('\n');
    const target = lines[line];
    if (target === undefined) return body;
    const m = LIST_RE.exec(target.replace(/\r$/, ''));
    if (!m || m[3] === undefined) return body;
    lines[line] = target.replace(/\[([ xX])\]/, m[3] === ' ' ? '[x]' : '[ ]');
    return lines.join('\n');
}

/** Unchecked task texts, in order. */
export function openTasks(body) {
    return parseBlocks(body)
        .filter((b) => b.type === 'item' && b.task === false)
        .map((b) => b.text.trim())
        .filter(Boolean);
}

/** Task counts for the list badge. */
export function taskCounts(body) {
    let open = 0;
    let done = 0;
    for (const b of parseBlocks(body)) {
        if (b.type !== 'item' || b.task === null) continue;
        if (b.task) done++; else open++;
    }
    return { open, done };
}

/** Every distinct mention label in a body. */
export function mentionLabels(body) {
    const seen = new Set();
    for (const m of String(body ?? '').matchAll(MENTION_RE)) seen.add(m[1]);
    return [...seen];
}

/**
 * Replace each `@[Label]` with the name it resolves to now. `resolve(label)`
 * returns the current display name, or null when the target is gone (then the
 * label as written is kept — it is still the best name we have).
 */
export function resolveMentions(text, resolve) {
    return String(text ?? '').replace(MENTION_RE, (_, label) => resolve(label) ?? label);
}

/**
 * Drop `refs` the body no longer mentions, so deleting a mention from the text
 * does not leave a dangling link behind forever.
 */
export function pruneRefs(body, refs) {
    const live = new Set(mentionLabels(body));
    const next = {};
    for (const [label, ref] of Object.entries(refs ?? {})) {
        if (live.has(label)) next[label] = ref;
    }
    return next;
}

// ─── Editing helpers (textarea) ────────────────────────────────────────────

/**
 * Find the `@…` token the caret is inside. Null when the caret is not in one,
 * when the `@` is glued to a word (so `name@example.com` is left alone), when
 * the token is already a finished mention (`@[`), or when it ran past the cap.
 * Same rules as the gallery picker in the composer.
 */
export function findMentionQuery(text, caret) {
    if (caret < 1 || caret > text.length) return null;
    const lowerBound = Math.max(0, caret - MAX_MENTION_QUERY - 1);
    let at = -1;
    for (let i = caret - 1; i >= lowerBound; i--) {
        const ch = text[i];
        if (ch === '@') { at = i; break; }
        if (ch === '\n' || ch === ']' || ch === '[') return null;
    }
    if (at === -1) return null;
    const before = at > 0 ? text[at - 1] : '';
    if (before && !/[\s(]/.test(before)) return null;
    return { query: text.slice(at + 1, caret), start: at, end: caret };
}

function normalise(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rank mention candidates `{ kind, id, name, aliases?, hint? }` against a
 * query. Name prefix beats a word prefix beats an interior match beats an
 * alias match; ties go to the shorter name. An empty query lists the first
 * `limit` as given (the caller orders them: on-stage NPCs first).
 */
export function rankCandidates(candidates, query, limit = 8) {
    const q = normalise(query);
    if (!q) return candidates.slice(0, limit);
    const scored = [];
    for (const c of candidates) {
        const name = normalise(c.name);
        let score = -1;
        const idx = name.indexOf(q);
        if (idx === 0) score = 0;
        else if (idx > 0 && name[idx - 1] === ' ') score = 100 + idx;
        else if (idx > 0) score = 300 + idx;
        else {
            const aliases = String(c.aliases ?? '').split(',').map(normalise).filter(Boolean);
            if (aliases.some((a) => a.startsWith(q))) score = 500;
            else if (aliases.some((a) => a.includes(q))) score = 600;
        }
        if (score >= 0) scored.push({ c, score: score * 1000 + name.length });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map((s) => s.c);
}

/**
 * Pick a free label for a new mention. Two different NPCs both called "Kane"
 * get `Kane` and `Kane (2)`, so one label never points at two records.
 */
export function uniqueLabel(name, refs, kind, id) {
    const base = String(name ?? '').replace(/[\[\]\n]/g, '').trim().slice(0, 60) || 'unnamed';
    let label = base;
    let n = 2;
    while (refs[label] && !(refs[label].kind === kind && refs[label].id === id)) {
        label = `${base} (${n++})`;
    }
    return label;
}

/**
 * The list prefix to continue onto the next line when Enter is pressed at the
 * end of `line`, or null for a line that is not a list item. An empty item
 * returns `''` — the caller then clears the marker instead of adding another,
 * which is how every editor ends a list.
 */
export function continueList(line) {
    const m = LIST_RE.exec(line);
    if (!m) return null;
    if (!m[4].trim()) return '';
    const indent = m[1];
    const marker = m[2];
    const next = /\d/.test(marker)
        ? `${Number.parseInt(marker, 10) + 1}${marker.endsWith(')') ? ')' : '.'}`
        : marker;
    return `${indent}${next} ${m[3] === undefined ? '' : '[ ] '}`;
}
