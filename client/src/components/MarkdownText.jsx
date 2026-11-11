import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button className="md-copy-btn" onClick={copy} type="button">
          {copied ? <><Check size={12} /> Скопировано</> : <><Copy size={12} /> Копировать</>}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function applyInline(text, key = 0) {
  const parts = [];
  const re = /(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)|(`([^`]+?)`)|\[([^\]]+?)\]\(([^)]+?)\)|(https?:\/\/[^\s<>"')\]]+)|(www\.[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(?:\/[^\s<>"')\]]*)?)/g;
  let last = 0;
  let m;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])      parts.push(<strong key={`${key}-${idx++}`}>{m[2]}</strong>);
    else if (m[3]) parts.push(<em key={`${key}-${idx++}`}>{m[4]}</em>);
    else if (m[5]) parts.push(<code key={`${key}-${idx++}`} className="md-inline-code">{m[6]}</code>);
    else if (m[7]) {
      const href = m[8];
      if (/^https?:\/\/|^www\./i.test(href)) {
        parts.push(
          <a key={`${key}-${idx++}`} href={href} target="_blank" rel="noopener noreferrer" className="md-source-link">
            <span className="md-source-icon">🔗</span>{m[7]}
          </a>
        );
      } else {
        // Non-URL markdown link (AI annotation like [Name](Description)) → bold text only
        parts.push(<strong key={`${key}-${idx++}`}>{m[7]}</strong>);
      }
    }
    else if (m[9]) parts.push(
      <a key={`${key}-${idx++}`} href={m[9]} target="_blank" rel="noopener noreferrer" className="md-source-link">
        <span className="md-source-icon">🔗</span>{m[9].replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
      </a>
    );
    else if (m[10]) parts.push(
      <a key={`${key}-${idx++}`} href={`https://${m[10]}`} target="_blank" rel="noopener noreferrer" className="md-source-link">
        <span className="md-source-icon">🔗</span>{m[10].replace(/\/$/, '')}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Normalize non-standard AI formatting (emoji markers, bare sub-headings) to markdown
function preprocessMarkdown(text) {
  if (!text) return text;

  // Pass 1: convert emoji-prefixed lines and colon sub-headings to markdown
  const p1 = text.split('\n').map(raw => {
    const t = raw.trim();
    if (!t) return '';
    // Already has a markdown marker → skip
    if (/^#{1,4}\s|^[-*]\s|^\d+\.\s|^>\s/.test(t)) return raw;

    // Line starts with emoji/symbol (charCode ≥ 0x25A0: geometric shapes + all emoji surrogates)
    if (t.charCodeAt(0) >= 0x25A0) {
      // "🔹 1. Title" or "◆ 2. Title" → "## 1. Title"
      const nm = t.match(/^.{1,3}\s*(\d+[.)]\s.+)$/);
      if (nm) return `## ${nm[1]}`;
      // "📌 Text" or "🔥 Text:" → "### Text"
      const em = t.match(/^.{1,3}\s+(.+)$/);
      if (em && em[1].length > 1) return `### ${em[1]}`;
    }

    // "Label — description" with short label (≤3 words) → bullet item
    // "Прайслист — цены и описания..." → "- **Прайслист** — цены и описания..."
    const eDashIdx = t.search(/[—–]/);
    if (eDashIdx > 0 && eDashIdx <= 36) {
      const label = t.slice(0, eDashIdx).trim();
      const desc  = t.slice(eDashIdx + 1).trim();
      const labelWC = label.split(/\s+/).length;
      if (labelWC >= 1 && labelWC <= 3 && /^[А-ЯёA-Z]/.test(label) && desc.length > 0) {
        return `- **${label}** — ${desc}`;
      }
    }

    // Short Cyrillic/Latin line ending with colon → bold sub-heading
    // "Консультации:" → "**Консультации:**"
    if (t.endsWith(':') && t.length <= 72 && /^[А-ЯёA-Z]/.test(t)) {
      return `**${t}**`;
    }

    // Short standalone title line (2–4 words, no punctuation, no numbers) → section heading
    // "Как это работает" → "### Как это работает"
    const words = t.split(/\s+/);
    if (
      words.length >= 2 && words.length <= 4 && t.length <= 52 &&
      /^[А-ЯёA-Z]/.test(t) && /[а-яёa-z]/.test(t) &&
      !/[.,:;!?—–]/.test(t) && !/\d/.test(t) && !/https?:/.test(t)
    ) {
      return `### ${t}`;
    }

    return raw;
  });

  return p1.join('\n');
}

// Safety net: strip system tags in case useStreamingPoll didn't catch them
const _SYS_TAGS = 'DB_COMMAND|BOT_SETTINGS|BOT_COMMANDS|BOT_PREVIEW|WELCOME_MESSAGE|NOTIF_COMMAND';
const _SYS_RE = new RegExp(`<(${_SYS_TAGS})[\\s>][\\s\\S]*?<\\/\\1>|<(${_SYS_TAGS})[\\s\\S]*?\\/>`, 'gi');
const _SYS_PART = new RegExp(`<(?:${_SYS_TAGS})(?:[\\s>][\\s\\S]*)?$|<(?:DB|BOT|WELCO|NOTIF)[A-Z_]*(?:[\\s>][\\s\\S]*)?$`, 'gi');

function normalizeHtmlToMd(raw) {
  raw = raw.replace(_SYS_RE, '').replace(_SYS_PART, '');
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `• ${c.trim()}\n`)
    .replace(/<\/?ul[^>]*>/gi, '\n').replace(/<\/?ol[^>]*>/gi, '\n')
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, c) => `${'#'.repeat(+lvl)} ${c.trim()}\n`)
    .replace(/<[^>]+>/g, '');
}

export default function MarkdownText({ text, isAi }) {
  if (!text) return null;
  text = normalizeHtmlToMd(text);

  const segments = [];
  const codeRe = /```(\w*)\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', content: preprocessMarkdown(text.slice(last, m.index)) });
    segments.push({ type: 'code', lang: m[1], content: m[2].trimEnd() });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', content: preprocessMarkdown(text.slice(last)) });

  return (
    <div className={`md${isAi ? ' md-ai' : ''}`}>
      {segments.map((seg, si) => {
        if (seg.type === 'code') return <CodeBlock key={si} lang={seg.lang} code={seg.content} />;

        let lines = seg.content.split('\n');
        {
          const merged = [];
          for (const ln of lines) {
            const t = ln.trim();
            const prevT = merged.length > 0 ? merged[merged.length - 1].trim() : '';
            if (prevT && /^\|/.test(prevT) && t && !/^\|/.test(t) && t.includes('|')) {
              merged[merged.length - 1] = merged[merged.length - 1].trimEnd() + ' ' + t;
            } else {
              merged.push(ln);
            }
          }
          lines = merged;
        }
        const nodes = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];

          const hm = line.match(/^(#{1,4})\s+(.+)/);
          if (hm) {
            const lvl = Math.min(hm[1].length + 1, 5);
            const Tag = `h${lvl}`;
            nodes.push(<Tag key={`${si}-${i}`} className={`md-h md-h${hm[1].length}`}>{applyInline(hm[2], `${si}-${i}`)}</Tag>);
            i++; continue;
          }

          if (/^---+$/.test(line.trim())) {
            nodes.push(<hr key={`${si}-${i}`} className="md-hr" />);
            i++; continue;
          }

          if (/^\|.+\|/.test(line)) {
            const tableLines = [];
            while (i < lines.length && /^\|.+\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
            const isSep = (l) => /^\|[\s\-:|]+\|/.test(l);
            const parseRow = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
            const headerLine = tableLines[0];
            const bodyLines = tableLines.filter((l, idx) => idx !== 0 && !isSep(l));
            nodes.push(
              <div key={`${si}-tbl-${i}`} className="md-table-wrap">
                <table className="md-table">
                  <thead><tr>{parseRow(headerLine).map((h, hi) => <th key={hi}>{applyInline(h, `th-${si}-${hi}`)}</th>)}</tr></thead>
                  <tbody>{bodyLines.map((row, ri) => <tr key={ri}>{parseRow(row).map((cell, ci) => <td key={ci}>{applyInline(cell, `td-${si}-${ri}-${ci}`)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            );
            continue;
          }

          if (/^>\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
              items.push(lines[i].replace(/^>\s?/, ''));
              i++;
            }
            nodes.push(
              <blockquote key={`${si}-bq-${i}`} className="md-blockquote">
                {items.map((l, j) => <span key={j}>{applyInline(l, `${si}-bq-${i}-${j}`)}{j < items.length - 1 ? <br /> : null}</span>)}
              </blockquote>
            );
            continue;
          }

          if (/^[-*•·–—]\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^[-*•·–—]\s/.test(lines[i])) {
              const content = lines[i].replace(/^[-*•·–—]\s+/, '').replace(/^[•·]\s*/, '');
              if (!content.trim() && i + 1 < lines.length && lines[i + 1].trim() && !/^[-*•·–—]/.test(lines[i + 1].trim())) {
                // Empty bullet followed by content on next line (DOM conversion artifact) — merge
                i++;
                items.push(<li key={i}>{applyInline(lines[i], i)}</li>);
                i++;
              } else {
                items.push(<li key={i}>{applyInline(content, i)}</li>);
                i++;
              }
            }
            nodes.push(<ul key={`${si}-ul-${i}`} className="md-ul">{items}</ul>);
            continue;
          }

          // Lone bullet on its own line (artifact of stripped system tags) — skip it
          if (/^[•·–—]$/.test(line.trim())) {
            const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
            if (next !== '' && !/^[-*•·–—]\s/.test(next)) {
              lines[i + 1] = line.trim() + ' ' + lines[i + 1];
            }
            i++; continue;
          }

          if (/^\d+\.\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
              const content = lines[i].replace(/^\d+\.\s+/, '');
              items.push(<li key={i}>{applyInline(content, i)}</li>);
              i++;
            }
            nodes.push(<ol key={`${si}-ol-${i}`} className="md-ol">{items}</ol>);
            continue;
          }

          if (line.trim() === '') { i++; continue; }

          const rawParaLines = [];
          while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !/^(#{1,4}\s|[-*•·–—]\s|\d+\.\s|---+$|\|.+\|)/.test(lines[i])
          ) {
            rawParaLines.push(lines[i]);
            i++;
          }
          if (rawParaLines.length) {
            const paraLines = [];
            for (const l of rawParaLines) {
              const prev = paraLines[paraLines.length - 1];
              if (prev !== undefined) {
                const opens = (prev.match(/\(/g) || []).length;
                const closes = (prev.match(/\)/g) || []).length;
                if (opens > closes) { paraLines[paraLines.length - 1] = prev + ' ' + l.trimStart(); continue; }
              }
              paraLines.push(l);
            }
            let nextNonEmpty = '';
            for (let j = i; j < lines.length; j++) { if (lines[j].trim()) { nextNonEmpty = lines[j].trim(); break; } }
            const isCaption = /^\|.+\|/.test(nextNonEmpty);
            nodes.push(
              <p key={`${si}-p-${i}`} className={`md-p${isCaption ? ' md-table-caption' : ''}`}>
                {paraLines.map((l, j) => (
                  <span key={j}>{applyInline(l, `${si}-${i}-${j}`)}{j < paraLines.length - 1 ? <br /> : null}</span>
                ))}
              </p>
            );
          }
        }
        return <>{nodes}</>;
      })}
    </div>
  );
}
