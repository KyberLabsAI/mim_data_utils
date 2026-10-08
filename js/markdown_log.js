// Markdown text messages (Logger.log_md): per-session store + the "m" panel.
//
// Messages are kept in time order. The store holds at most MD_LOG_MAX_BYTES of
// text (UTF-8); beyond that the oldest messages are dropped. The panel shows
// every stored message as a bubble with its log time; while the time cursor
// is moved (rewinding the traces) the last message at or before the cursor is
// highlighted and scrolled into view, later ones are dimmed.

const MD_LOG_MAX_BYTES = 512 * 1024;
// A marker (Logger.log_marker) this close to a message's time is shown next
// to the message's time stamp.
const MD_MARK_TOLERANCE_S = 0.05;

const _mdEncoder = new TextEncoder();

class MarkdownLog {
    constructor(maxBytes = MD_LOG_MAX_BYTES) {
        this.maxBytes = maxBytes;
        this.clear();
    }

    clear() {
        this.messages = [];     // {seq, time, text, bytes}, sorted by time
        this.bytes = 0;
        this.nextSeq = 0;
        this.version = 0;       // bumped on every change (panel re-sync)
    }

    add(time, text) {
        text = String(text);
        let bytes = _mdEncoder.encode(text).length;
        if (bytes > this.maxBytes) {
            // A single message larger than the whole budget: keep its start.
            text = text.slice(0, this.maxBytes) + '\n\n*… truncated*';
            bytes = _mdEncoder.encode(text).length;
        }
        const msg = {seq: this.nextSeq++, time: time, text: text, bytes: bytes};

        // Messages normally arrive in time order; insert in place otherwise.
        let i = this.messages.length;
        while (i > 0 && this.messages[i - 1].time > time) {
            i--;
        }
        this.messages.splice(i, 0, msg);
        this.bytes += bytes;

        while (this.bytes > this.maxBytes && this.messages.length > 1) {
            this.bytes -= this.messages.shift().bytes;
        }
        this.version++;
        return msg;
    }

    // Index of the last message at or before `time`, -1 if none.
    indexAt(time) {
        let lo = 0, hi = this.messages.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.messages[mid].time <= time) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    }
}

// --- minimal, safe markdown -> HTML -------------------------------------------
// Escapes all HTML first; supports headings, paragraphs, **bold**, *italic*,
// `code`, fenced code blocks, lists, block quotes, links (http/https only),
// horizontal rules and pipe tables.

function _mdEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}

function _mdInline(s) {
    const codes = [];
    const keep = (html) => {
        codes.push(html);
        return `\u0000${codes.length - 1}\u0000`;
    };
    s = _mdEscape(s).replace(/`([^`]+)`/g, (_, c) => keep(`<code>${c}</code>`));
    // Images first (`![alt](src)`): base64 data URLs (Logger.md_image) or http(s).
    s = s.replace(/!\[([^\]]*)\]\((data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+\/=]+|https?:\/\/[^\s)]+)\)/g,
                  (_, alt, src) => keep(`<img class="md-img" alt="${alt}" src="${src}">`));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                  '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

function _mdTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function renderMarkdown(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        let m;
        if ((m = line.match(/^\s*```(.*)$/))) {                    // fenced code
            const body = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) {
                body.push(lines[i++]);
            }
            i++;
            out.push(`<pre><code>${_mdEscape(body.join('\n'))}</code></pre>`);
            continue;
        }
        if (/^\s*$/.test(line)) {
            i++;
            continue;
        }
        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
            const n = m[1].length;
            out.push(`<h${n}>${_mdInline(m[2])}</h${n}>`);
            i++;
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push('<hr>');
            i++;
            continue;
        }
        if (line.includes('|') && i + 1 < lines.length &&
                /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
            const head = _mdTableRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
                rows.push(_mdTableRow(lines[i++]));
            }
            out.push('<table><thead><tr>' + head.map(c => `<th>${_mdInline(c)}</th>`).join('') +
                     '</tr></thead><tbody>' +
                     rows.map(r => '<tr>' + r.map(c => `<td>${_mdInline(c)}</td>`).join('') + '</tr>').join('') +
                     '</tbody></table>');
            continue;
        }
        if (/^\s*>/.test(line)) {
            const body = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                body.push(lines[i++].replace(/^\s*>\s?/, ''));
            }
            out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
            continue;
        }
        if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
            const ordered = /^\s*\d+[.)]\s+/.test(line);
            const items = [];
            while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
                items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}>` + items.map(it => `<li>${_mdInline(it)}</li>`).join('') + `</${tag}>`);
            continue;
        }
        const para = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) &&
               !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) {
            para.push(_mdInline(lines[i++]));
        }
        out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('\n');
}

function _mdFormatTime(t) {
    const d = new Date(t * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
           pad(d.getMilliseconds(), 3);
}

// --- the "m" panel --------------------------------------------------------------

class MarkdownPanel {
    constructor(container) {
        this.container = container;
        this.log = null;
        this.version = -1;
        this.bubbles = new Map();   // seq -> element
        this.active = -1;           // seq of the highlighted message
        this.marksSeen = -1;        // marker count the labels were computed for
        this.emptyNote = document.createElement('div');
        this.emptyNote.className = 'md-empty';
        this.emptyNote.textContent = 'No messages (Logger.log_md)';
        this.container.appendChild(this.emptyNote);
    }

    _makeBubble(msg) {
        const el = document.createElement('div');
        el.className = 'md-bubble';
        const time = document.createElement('div');
        time.className = 'md-time';
        time.textContent = _mdFormatTime(msg.time);
        const mark = document.createElement('span');
        mark.className = 'md-mark';
        time.appendChild(mark);
        el._mdMark = mark;
        // Move the time cursor to this message, as a click in the plots would
        // (main.js mdGotoTime). A button, so selecting / copying the text in
        // the bubble does not jump.
        const goto = document.createElement('button');
        goto.className = 'md-goto';
        goto.textContent = 'goto';
        goto.title = 'Move the time cursor to this message';
        goto.addEventListener('click', (evt) => {
            evt.stopPropagation();
            mdGotoTime(msg.time);
        });
        time.appendChild(goto);
        const body = document.createElement('div');
        body.className = 'md-body';
        body.innerHTML = renderMarkdown(msg.text);
        el.appendChild(time);
        el.appendChild(body);
        return el;
    }

    // Bring the DOM in line with the log: drop evicted bubbles, insert new ones
    // at their (time-ordered) position.
    _syncMessages(log) {
        if (log !== this.log) {
            this.log = log;
            this.bubbles.forEach(el => el.remove());
            this.bubbles.clear();
            this.active = -1;
            this.version = -1;
        }
        if (log.version === this.version) {
            return false;
        }
        this.version = log.version;

        const keep = new Set(log.messages.map(m => m.seq));
        this.bubbles.forEach((el, seq) => {
            if (!keep.has(seq)) {
                el.remove();
                this.bubbles.delete(seq);
            }
        });
        let prev = null;
        log.messages.forEach(msg => {
            let el = this.bubbles.get(msg.seq);
            if (!el) {
                el = this._makeBubble(msg);
                this.bubbles.set(msg.seq, el);
                if (prev) {
                    prev.after(el);
                } else {
                    this.container.insertBefore(el, this.emptyNote.nextSibling);
                }
            }
            prev = el;
        });
        this.emptyNote.style.display = log.messages.length ? 'none' : 'block';
        return true;
    }

    // Label each bubble with the markers logged at (about) its time.
    _syncMarks(log, marks, force) {
        const all = marks ? marks.getMarks() : [];
        if (!force && all.length === this.marksSeen) {
            return;
        }
        this.marksSeen = all.length;
        log.messages.forEach(msg => {
            const el = this.bubbles.get(msg.seq);
            if (!el) return;
            const labels = all.filter(m => Math.abs(m.time - msg.time) <= MD_MARK_TOLERANCE_S)
                              .map(m => m.label);
            el._mdMark.textContent = labels.length ? `  ${labels.join(' ')}` : '';
        });
    }

    syncToTime(log, time, marks = null) {
        const changed = this._syncMessages(log);
        this._syncMarks(log, marks, changed);
        const idx = time == null ? log.messages.length - 1 : log.indexAt(time);
        const seq = idx >= 0 ? log.messages[idx].seq : -1;
        if (seq === this.active && !changed) {
            return;
        }
        this.active = seq;
        log.messages.forEach((msg, i) => {
            const el = this.bubbles.get(msg.seq);
            el.classList.toggle('md-current', i === idx);
            el.classList.toggle('md-future', i > idx);
        });
        const el = this.bubbles.get(seq);
        if (el) {
            el.scrollIntoView({block: 'nearest'});
        }
    }
}
