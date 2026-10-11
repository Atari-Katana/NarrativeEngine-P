// Player Journal — the window interior.
//
// Plain DOM, no framework: the host hands us a node and we fill it. One mount
// per open window. Everything it knows about the journal comes through `api`
// (built in index.js), so this file never touches `ctx` or the tables itself.
//
// Two modes per entry:
//   Write — a textarea holding the Markdown, a formatting toolbar, `@` mentions.
//   Read  — the rendered page; task checkboxes tick in place.
// The body is saved shortly after typing stops, and immediately on any switch
// (entry, mode, window close), so nothing typed is lost to the debounce.

import {
    parseBlocks, parseInline, toggleTask, taskCounts, findMentionQuery,
    rankCandidates, uniqueLabel, continueList, pruneRefs,
} from './markdown.js';
import { makeResolver, worldStamp, MAX_ARMED } from './prompt.js';

const SAVE_DELAY_MS = 400;

function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in node && key !== 'list') node[key] = value;
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function shortDate(ms) {
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function stampLine(entry) {
    return [worldStamp(entry.stamp), shortDate(entry.createdAt)].filter(Boolean).join(' · ');
}

// ─── Rendering (read mode) ─────────────────────────────────────────────────

function renderInline(spans, resolveRef) {
    return spans.map((s) => {
        if (s.t === 'text') return document.createTextNode(s.v);
        if (s.t === 'code') return el('code', { text: s.v });
        if (s.t === 'strong') return el('strong', null, renderInline(s.c, resolveRef));
        if (s.t === 'em') return el('em', null, renderInline(s.c, resolveRef));
        if (s.t === 'del') return el('del', null, renderInline(s.c, resolveRef));
        const hit = resolveRef(s.label);
        if (!hit) {
            return el('span', {
                className: 'pj-mention pj-mention--gone',
                title: 'Not linked to anything in the ledgers',
                text: s.label,
            });
        }
        return el('span', {
            className: `pj-mention pj-mention--${hit.kind}`,
            title: hit.hint || hit.kindLabel,
            text: hit.name,
        });
    });
}

function renderPage(entry, resolveRef, onToggle) {
    const page = el('div', { className: 'pj-page' });
    const blocks = parseBlocks(entry.body);
    if (blocks.length === 0) {
        page.append(el('p', { className: 'pj-page-empty', text: 'This page is blank. Switch to Write to start.' }));
        return page;
    }
    for (const b of blocks) {
        if (b.type === 'heading') {
            page.append(el(`h${b.level + 2}`, { className: 'pj-h' }, renderInline(parseInline(b.text), resolveRef)));
        } else if (b.type === 'rule') {
            page.append(el('hr', { className: 'pj-rule' }));
        } else if (b.type === 'quote') {
            page.append(el('blockquote', { className: 'pj-quote' },
                b.lines.map((l, i) => [i ? el('br') : null, renderInline(parseInline(l), resolveRef)])));
        } else if (b.type === 'para') {
            page.append(el('p', { className: 'pj-p' },
                b.lines.map((l, i) => [i ? el('br') : null, renderInline(parseInline(l), resolveRef)])));
        } else {
            const item = el('div', {
                className: `pj-li${b.task === true ? ' pj-li--done' : ''}`,
                style: `--pj-indent:${b.indent}`,
            });
            if (b.task !== null) {
                const box = el('input', {
                    type: 'checkbox',
                    className: 'pj-check',
                    checked: b.task,
                    'aria-label': b.task ? 'Mark as not done' : 'Mark as done',
                    onChange: () => onToggle(b.line),
                });
                item.append(box);
            } else {
                item.append(el('span', { className: 'pj-marker', 'aria-hidden': 'true', text: b.ordered ? `${b.number}.` : '•' }));
            }
            item.append(el('span', { className: 'pj-li-text' }, renderInline(parseInline(b.text), resolveRef)));
            page.append(item);
        }
    }
    return page;
}

// ─── Textarea helpers (write mode) ─────────────────────────────────────────

/** Pixel position of `pos` inside a textarea, via the usual mirror-div trick. */
function caretCoords(textarea, pos) {
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const prop of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize',
        'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize']) {
        mirror.style[prop] = style[prop];
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.textContent = textarea.value.slice(0, pos);
    const marker = document.createElement('span');
    marker.textContent = textarea.value.slice(pos) || '.';
    mirror.append(marker);
    document.body.append(mirror);
    const top = marker.offsetTop - textarea.scrollTop;
    const left = marker.offsetLeft - textarea.scrollLeft;
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
    mirror.remove();
    return { top, left, lineHeight };
}

function lineBounds(value, start, end) {
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to === -1) to = value.length;
    return { from, to };
}

const PREFIX_RE = /^(\s*)(?:#{1,3}\s+|>\s?|(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/** Apply (or, when every selected line already has it, remove) a line prefix. */
function applyLinePrefix(textarea, kind) {
    const { value, selectionStart, selectionEnd } = textarea;
    const { from, to } = lineBounds(value, selectionStart, selectionEnd);
    const lines = value.slice(from, to).split('\n');
    const prefixFor = (i) => ({
        h: '## ', bullet: '- ', number: `${i + 1}. `, task: '- [ ] ', quote: '> ',
    })[kind];
    const has = (line) => ({
        h: /^\s*#{1,3}\s/, bullet: /^\s*[-*+]\s+(?!\[[ xX]\])/, number: /^\s*\d{1,3}[.)]\s/,
        task: /^\s*[-*+]\s+\[[ xX]\]\s/, quote: /^\s*>/,
    })[kind].test(line);
    const removing = lines.every((l) => !l.trim() || has(l));
    let n = 0;
    const next = lines.map((line) => {
        if (!line.trim() && lines.length > 1) return line;
        const m = PREFIX_RE.exec(line);
        const indent = m ? m[1] : '';
        const rest = m ? line.slice(m[0].length) : line;
        return removing ? indent + rest : indent + prefixFor(n++) + rest;
    }).join('\n');
    textarea.setRangeText(next, from, to, 'select');
    if (lines.length === 1) textarea.setSelectionRange(from + next.length, from + next.length);
}

function wrapSelection(textarea, mark) {
    const { value, selectionStart: s, selectionEnd: e } = textarea;
    const selected = value.slice(s, e);
    if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= mark.length * 2) {
        textarea.setRangeText(selected.slice(mark.length, -mark.length), s, e, 'select');
        return;
    }
    if (value.slice(s - mark.length, s) === mark && value.slice(e, e + mark.length) === mark) {
        textarea.setRangeText(selected, s - mark.length, e + mark.length, 'select');
        return;
    }
    textarea.setRangeText(`${mark}${selected}${mark}`, s, e, 'select');
    if (!selected) textarea.setSelectionRange(s + mark.length, s + mark.length);
    else textarea.setSelectionRange(s + mark.length, e + mark.length);
}

// ─── The window ────────────────────────────────────────────────────────────

/**
 * Fill `root` with the journal. `api` is the mod's facade:
 *   getState()          → { campaignId, entries, meta }
 *   world()             → resolver input for prompt.js
 *   candidates()        → mention candidates, best-first
 *   subscribe(fn)       → unsubscribe; fn runs after any state change
 *   createEntry()       → new entry (already saved)
 *   updateEntry(id, patch)
 *   deleteEntry(id)
 *   toggleArm(id, mode) → false when the armed cap is reached
 *   setLastOpen(id)
 * Returns the teardown.
 */
export function mountJournal(root, api) {
    let selectedId = api.getState().meta.lastOpenId ?? null;
    let mode = null;              // 'write' | 'read' — null means "pick for this entry"
    let filter = '';
    let pendingSave = null;       // { id, patch } waiting on the debounce
    let saveTimer = null;
    let mention = null;           // { query, start, end, items, index }
    let deleteArmedAt = 0;
    let ownWrites = 0;            // >0 while this window is writing; see `subscribe` below

    const app = el('div', { className: 'pj-app' });
    root.append(app);
    // Buttons never take focus from the editor on mousedown. Otherwise the
    // textarea's blur saves, the save repaints, and the button under the
    // pointer is replaced between mousedown and mouseup, so the click is
    // lost. Keyboard activation is unaffected.
    app.addEventListener('mousedown', (ev) => {
        if (ev.target instanceof Element && ev.target.closest('button')) ev.preventDefault();
    });

    /** Run one of this window's own writes. The window repaints what it
     *  needs itself, so the change notification must not repaint over it. */
    const own = (fn) => {
        ownWrites++;
        try { return fn(); } finally { ownWrites--; }
    };

    const flushSave = () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (!pendingSave) return;
        const { id, patch } = pendingSave;
        pendingSave = null;
        own(() => api.updateEntry(id, patch));
    };
    const queueSave = (id, patch) => {
        if (pendingSave && pendingSave.id !== id) flushSave();
        pendingSave = { id, patch: { ...(pendingSave?.patch ?? {}), ...patch } };
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
    };

    const entryById = (id) => api.getState().entries.find((e) => e.id === id) ?? null;
    /** The entry as the user currently sees it — stored copy plus unsaved edits. */
    const current = () => {
        const stored = entryById(selectedId);
        if (!stored) return null;
        return pendingSave && pendingSave.id === stored.id ? { ...stored, ...pendingSave.patch } : stored;
    };

    const select = (id) => {
        flushSave();
        selectedId = id;
        mode = null;
        mention = null;
        own(() => api.setLastOpen(id));
        paint();
    };

    const resolverFor = (entry) => {
        const world = api.world();
        const names = makeResolver(entry.refs, world);
        return (label) => {
            const ref = entry.refs?.[label];
            if (!ref) return null;
            const name = names(label);
            if (name == null) return null;
            if (ref.kind === 'npc') {
                const npc = world.npcs.get(ref.id);
                const hint = [npc?.faction, npc?.storyRelevance].filter((s) => s && String(s).trim()).join(' · ');
                return { kind: 'npc', kindLabel: 'NPC', name, hint: hint ? `NPC · ${hint}` : 'NPC' };
            }
            if (ref.kind === 'place') {
                const place = world.places.get(ref.id);
                return { kind: 'place', kindLabel: 'Place', name, hint: place?.broadLocation ? `Place · ${place.broadLocation}` : 'Place' };
            }
            return { kind: 'pc', kindLabel: 'Your character', name, hint: 'Your character' };
        };
    };

    // ── Side list ──────────────────────────────────────────────────────────
    function paintList() {
        const { entries, meta } = api.getState();
        const armed = new Map((meta.armed ?? []).map((a) => [a.entryId, a.mode]));
        const q = filter.trim().toLowerCase();
        const shown = [...entries]
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .filter((e) => !q || `${e.title}\n${e.body}`.toLowerCase().includes(q));

        const list = el('div', { className: 'pj-list', role: 'listbox', 'aria-label': 'Journal entries' });
        if (shown.length === 0) {
            list.append(el('div', { className: 'pj-list-empty', text: q ? 'No entry matches.' : 'No entries yet.' }));
        }
        for (const e of shown) {
            const live = e.id === selectedId ? current() ?? e : e;
            const { open } = taskCounts(live.body);
            const armedMode = armed.get(e.id);
            list.append(el('button', {
                type: 'button',
                className: `pj-list-item${e.id === selectedId ? ' is-active' : ''}`,
                role: 'option',
                'aria-selected': e.id === selectedId ? 'true' : 'false',
                onClick: () => select(e.id),
            },
            el('span', { className: 'pj-list-title', text: live.title?.trim() || 'Untitled' }),
            el('span', { className: 'pj-list-meta' },
                el('span', { className: 'pj-list-stamp', text: stampLine(e) }),
                open ? el('span', { className: 'pj-tag', title: `${open} open to-do${open === 1 ? '' : 's'}`, text: `${open} open` }) : null,
                e.private ? el('span', { className: 'pj-tag pj-tag--lock', title: 'Private: hidden from Ask GM', text: 'Private' }) : null,
                armedMode ? el('span', { className: 'pj-tag pj-tag--armed', title: 'Goes with your next message', text: armedMode === 'show' ? 'Showing' : 'Reminding' }) : null,
            )));
        }
        return list;
    }

    // ── Main pane ──────────────────────────────────────────────────────────
    function paintMain() {
        const main = el('section', { className: 'pj-main' });
        const entry = current();
        if (!entry) {
            main.append(el('div', { className: 'pj-empty' },
                el('p', { text: api.getState().entries.length ? 'Pick an entry, or start a new one.' : 'Your journal is empty.' }),
                el('button', { type: 'button', className: 'pj-btn pj-btn--primary', onClick: newEntry, text: 'New entry' })));
            return main;
        }
        if (!mode) mode = entry.body.trim() ? 'read' : 'write';

        const title = el('input', {
            className: 'pj-title',
            value: entry.title ?? '',
            placeholder: 'Untitled',
            'aria-label': 'Entry title',
            maxLength: 120,
            onInput: (ev) => { queueSave(entry.id, { title: ev.target.value }); refreshList(); },
            onBlur: flushSave,
        });
        const modeBtn = (value, label) => el('button', {
            type: 'button',
            className: `pj-seg${mode === value ? ' is-active' : ''}`,
            'aria-pressed': mode === value ? 'true' : 'false',
            onClick: () => { if (mode !== value) { flushSave(); mode = value; mention = null; paint(); } },
            text: label,
        });
        main.append(el('header', { className: 'pj-head' },
            el('div', { className: 'pj-head-row' }, title,
                el('div', { className: 'pj-segs', role: 'group', 'aria-label': 'Mode' }, modeBtn('write', 'Write'), modeBtn('read', 'Read'))),
            el('div', { className: 'pj-stamp', text: stampLine(entry) || 'No stamp' })));

        if (mode === 'read') {
            main.append(el('div', { className: 'pj-scroll' }, renderPage(entry, resolverFor(entry), (line) => {
                flushSave();
                const fresh = entryById(entry.id);
                if (fresh) own(() => api.updateEntry(entry.id, { body: toggleTask(fresh.body, line) }));
                paint();
            })));
        } else {
            main.append(paintWriter(entry));
        }

        main.append(paintFooter(entry));
        return main;
    }

    function paintWriter(entry) {
        const wrap = el('div', { className: 'pj-writer' });
        const textarea = el('textarea', {
            className: 'pj-textarea',
            value: entry.body ?? '',
            placeholder: 'Write here. Type @ to link a character or place.',
            'aria-label': 'Entry text',
            spellcheck: true,
        });
        const pop = el('div', { className: 'pj-pop', role: 'listbox', 'aria-label': 'Link a character or place', hidden: true });

        const commit = () => {
            const refs = pruneRefs(textarea.value, current()?.refs ?? entry.refs ?? {});
            queueSave(entry.id, { body: textarea.value, refs });
            refreshList();
        };

        const closePop = () => { mention = null; pop.hidden = true; pop.replaceChildren(); };
        const paintPop = () => {
            if (!mention || mention.items.length === 0) { closePop(); return; }
            pop.replaceChildren(...mention.items.map((c, i) => el('div', {
                className: `pj-pop-item${i === mention.index ? ' is-active' : ''}`,
                role: 'option',
                'aria-selected': i === mention.index ? 'true' : 'false',
                onMousedown: (ev) => { ev.preventDefault(); pickMention(i); },
            },
            el('span', { className: `pj-pop-kind pj-pop-kind--${c.kind}`, text: c.kind === 'npc' ? 'NPC' : c.kind === 'place' ? 'Place' : 'You' }),
            el('span', { className: 'pj-pop-name', text: c.name }),
            c.hint ? el('span', { className: 'pj-pop-hint', text: c.hint }) : null)));
            const at = caretCoords(textarea, mention.start);
            const maxLeft = Math.max(0, textarea.clientWidth - 260);
            pop.style.left = `${Math.min(at.left, maxLeft) + textarea.offsetLeft}px`;
            pop.style.top = `${at.top + at.lineHeight + textarea.offsetTop + 4}px`;
            pop.hidden = false;
        };
        const updateMention = () => {
            const found = findMentionQuery(textarea.value, textarea.selectionStart);
            if (!found || textarea.selectionStart !== textarea.selectionEnd) { closePop(); return; }
            const items = rankCandidates(api.candidates(), found.query, 8);
            mention = { ...found, items, index: Math.min(mention?.index ?? 0, Math.max(0, items.length - 1)) };
            paintPop();
        };
        const pickMention = (i) => {
            const c = mention?.items[i];
            if (!c) return;
            const refs = { ...(current()?.refs ?? {}) };
            const label = uniqueLabel(c.name, refs, c.kind, c.id);
            refs[label] = { kind: c.kind, id: c.id };
            const insert = `@[${label}] `;
            textarea.setRangeText(insert, mention.start, mention.end, 'end');
            closePop();
            queueSave(entry.id, { body: textarea.value, refs: pruneRefs(textarea.value, refs) });
            textarea.focus();
        };

        textarea.addEventListener('input', () => { commit(); updateMention(); });
        textarea.addEventListener('click', updateMention);
        textarea.addEventListener('blur', () => { closePop(); flushSave(); });
        textarea.addEventListener('scroll', () => { if (mention) paintPop(); });
        textarea.addEventListener('keydown', (ev) => {
            if (mention && mention.items.length) {
                if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                    ev.preventDefault();
                    const n = mention.items.length;
                    mention.index = (mention.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
                    paintPop();
                    return;
                }
                if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); pickMention(mention.index); return; }
                if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePop(); return; }
            }
            if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'b' || ev.key === 'i')) {
                ev.preventDefault();
                wrapSelection(textarea, ev.key === 'b' ? '**' : '*');
                commit();
                return;
            }
            if (ev.key === 'Enter' && !ev.shiftKey && textarea.selectionStart === textarea.selectionEnd) {
                const pos = textarea.selectionStart;
                const { from } = lineBounds(textarea.value, pos, pos);
                const atLineEnd = textarea.value[pos] === undefined || textarea.value[pos] === '\n';
                if (!atLineEnd) return;
                const next = continueList(textarea.value.slice(from, pos));
                if (next === null) return;
                ev.preventDefault();
                if (next === '') textarea.setRangeText('', from, pos, 'end');
                else textarea.setRangeText(`\n${next}`, pos, pos, 'end');
                commit();
            }
        });
        textarea.addEventListener('keyup', (ev) => {
            if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') updateMention();
        });

        const tool = (label, title, run) => el('button', {
            type: 'button',
            className: 'pj-tool',
            title,
            'aria-label': title,
            onMousedown: (ev) => ev.preventDefault(),
            onClick: () => { run(); commit(); textarea.focus(); },
        }, label);
        const insertAt = () => {
            const pos = textarea.selectionStart;
            const before = pos > 0 ? textarea.value[pos - 1] : '';
            textarea.setRangeText(before && !/\s/.test(before) ? ' @' : '@', pos, textarea.selectionEnd, 'end');
            setTimeout(updateMention, 0);
        };
        const toolbar = el('div', { className: 'pj-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
            tool(el('b', { text: 'B' }), 'Bold (Ctrl+B)', () => wrapSelection(textarea, '**')),
            tool(el('i', { text: 'I' }), 'Italic (Ctrl+I)', () => wrapSelection(textarea, '*')),
            tool(el('s', { text: 'S' }), 'Strikethrough', () => wrapSelection(textarea, '~~')),
            el('span', { className: 'pj-tool-sep', 'aria-hidden': 'true' }),
            tool('H', 'Heading', () => applyLinePrefix(textarea, 'h')),
            tool('•', 'Bulleted list', () => applyLinePrefix(textarea, 'bullet')),
            tool('1.', 'Numbered list', () => applyLinePrefix(textarea, 'number')),
            tool('☐', 'Checkbox', () => applyLinePrefix(textarea, 'task')),
            tool('“', 'Quote', () => applyLinePrefix(textarea, 'quote')),
            el('span', { className: 'pj-tool-sep', 'aria-hidden': 'true' }),
            tool('@', 'Link a character or place', insertAt));

        wrap.append(toolbar, el('div', { className: 'pj-writer-body' }, textarea, pop));
        setTimeout(() => { if (textarea.isConnected && document.activeElement !== textarea && !entry.body) textarea.focus(); }, 0);
        return wrap;
    }

    function paintFooter(entry) {
        const { meta } = api.getState();
        const armed = (meta.armed ?? []).find((a) => a.entryId === entry.id)?.mode ?? null;
        const armedCount = (meta.armed ?? []).length;

        const arm = (value, label, title) => el('button', {
            type: 'button',
            className: `pj-btn${armed === value ? ' is-armed' : ''}`,
            'aria-pressed': armed === value ? 'true' : 'false',
            title,
            onClick: () => {
                flushSave();
                if (!own(() => api.toggleArm(entry.id, value))) {
                    status.textContent = `At most ${MAX_ARMED} entries can go with one message.`;
                    return;
                }
                paint();
            },
            text: label,
        });

        const del = el('button', {
            type: 'button',
            className: 'pj-btn pj-btn--danger',
            onClick: () => {
                if (Date.now() - deleteArmedAt < 3000) {
                    if (saveTimer) clearTimeout(saveTimer);
                    pendingSave = null;
                    deleteArmedAt = 0;
                    own(() => api.deleteEntry(entry.id));
                    selectedId = null;
                    paint();
                    return;
                }
                deleteArmedAt = Date.now();
                del.textContent = 'Confirm delete';
                setTimeout(() => { if (del.isConnected) del.textContent = 'Delete'; deleteArmedAt = 0; }, 3000);
            },
            text: 'Delete',
        });

        const privacy = el('button', {
            type: 'button',
            className: `pj-btn${entry.private ? ' is-on' : ''}`,
            'aria-pressed': entry.private ? 'true' : 'false',
            title: entry.private
                ? 'Private: Ask GM never reads this entry. Remind and Show still send it when you choose.'
                : 'Shared: the GM can read this when you use Ask GM.',
            onClick: () => { flushSave(); own(() => api.updateEntry(entry.id, { private: !entry.private })); paint(); },
            text: entry.private ? 'Private' : 'Shared with Ask GM',
        });

        const note = armed === 'remind'
            ? 'Goes with your next message as an out-of-character note. Characters won’t know it.'
            : armed === 'show'
                ? 'Goes with your next message as shown in the scene. Characters present will know it.'
                : armedCount ? `${armedCount} entr${armedCount === 1 ? 'y goes' : 'ies go'} with your next message.` : '';
        const status = el('div', { className: 'pj-status', role: 'status', text: note });

        return el('footer', { className: 'pj-foot' },
            el('div', { className: 'pj-foot-row' },
                privacy,
                el('span', { className: 'pj-foot-gap' }),
                arm('remind', 'Remind GM', 'Send this entry with your next message as an out-of-character note for the GM'),
                arm('show', 'Show in scene', 'Send this entry with your next message as shown or read in the scene'),
                del),
            status);
    }

    function newEntry() {
        flushSave();
        const entry = own(() => api.createEntry());
        if (!entry) return;
        selectedId = entry.id;
        mode = 'write';
        own(() => api.setLastOpen(entry.id));
        paint();
        setTimeout(() => app.querySelector('.pj-title')?.focus(), 0);
    }

    // ── Paint ──────────────────────────────────────────────────────────────
    let listSlot = null;
    const refreshList = () => {
        if (!listSlot) return;
        listSlot.replaceChildren(paintList());
    };

    function paint() {
        const { campaignId, entries } = api.getState();
        if (!campaignId) {
            app.replaceChildren(el('div', { className: 'pj-empty' }, el('p', { text: 'Open a campaign to use the journal.' })));
            listSlot = null;
            return;
        }
        if (selectedId && !entries.some((e) => e.id === selectedId)) selectedId = null;

        const search = el('input', {
            className: 'pj-search',
            type: 'search',
            placeholder: 'Search',
            'aria-label': 'Search entries',
            value: filter,
            onInput: (ev) => { filter = ev.target.value; refreshList(); },
        });
        listSlot = el('div', { className: 'pj-list-slot' }, paintList());
        app.replaceChildren(el('div', { className: 'pj-body' },
            el('aside', { className: 'pj-side' },
                el('div', { className: 'pj-side-head' }, search,
                    el('button', { type: 'button', className: 'pj-btn pj-btn--primary', onClick: newEntry, text: 'New' })),
                listSlot),
            paintMain()));
    }

    // External changes (a table write, a campaign switch, an armed entry
    // being sent). This window's own writes only refresh the list: it has
    // already painted what they change. Repainting the editor while the user
    // is typing in it would steal the caret, so that case refreshes the list
    // and leaves the editor alone too.
    const unsubscribe = api.subscribe(() => {
        if (ownWrites > 0) { refreshList(); return; }
        const active = document.activeElement;
        const editing = active && app.contains(active) && (active.matches('textarea, input.pj-title, input.pj-search'));
        if (editing) { refreshList(); return; }
        paint();
    });

    paint();

    return () => {
        flushSave();
        unsubscribe();
        root.replaceChildren();
    };
}
