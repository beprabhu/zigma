'use client';

// A small Markdown reader for skill files.
//
// Scope is deliberate: skills are prompts, so they use headings, paragraphs, lists, blockquotes,
// fenced code, rules and the inline run of bold/italic/code/links. That is what this renders.
// It is NOT a CommonMark implementation — no tables, no nested lists, no reference links, no
// HTML passthrough. If a skill ever needs those, the answer is `react-markdown`, not more
// regexes here.
//
// Everything is built as React elements. Nothing in this project uses dangerouslySetInnerHTML
// and a preview of text the user typed is a poor place to start.

import * as React from 'react';

/** Inline run: **bold**, *italic*, `code`, [text](href). Nesting beyond one level is not read. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('**')) {
      out.push(<strong key={key} className="font-semibold">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(token) ?? [];
      out.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          {label}
        </a>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = React.useMemo(() => {
    const lines = source.split('\n');
    const nodes: React.ReactNode[] = [];
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    let quote: string[] = [];
    let code: { lang: string; lines: string[] } | null = null;
    let key = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      nodes.push(<p key={key++}>{inline(paragraph.join(' '), `p${key}`)}</p>);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      const Tag = list.ordered ? 'ol' : 'ul';
      nodes.push(
        <Tag key={key++} className={list.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}>
          {list.items.map((item, n) => (
            <li key={n}>{inline(item, `li${key}-${n}`)}</li>
          ))}
        </Tag>,
      );
      list = null;
    };
    const flushQuote = () => {
      if (!quote.length) return;
      nodes.push(
        <blockquote key={key++} className="border-l-2 pl-3 text-muted-foreground">
          {inline(quote.join(' '), `q${key}`)}
        </blockquote>,
      );
      quote = [];
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');

      // Fenced code swallows everything until its closing fence, formatting included.
      if (/^```/.test(line)) {
        if (code) {
          nodes.push(
            <pre
              key={key++}
              className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[0.85em]"
            >
              <code>{code.lines.join('\n')}</code>
            </pre>,
          );
          code = null;
        } else {
          flushAll();
          code = { lang: line.slice(3).trim(), lines: [] };
        }
        continue;
      }
      if (code) {
        code.lines.push(raw);
        continue;
      }

      if (!line.trim()) {
        flushAll();
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushAll();
        nodes.push(<hr key={key++} className="border-border" />);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        const size =
          level === 1 ? 'text-base font-semibold' :
          level === 2 ? 'text-sm font-semibold' : 'text-sm font-medium';
        const Tag = `h${Math.min(level + 1, 6)}` as React.ElementType;
        nodes.push(
          <Tag key={key++} className={`${size} mt-1`}>
            {inline(heading[2], `h${key}`)}
          </Tag>,
        );
        continue;
      }

      const quoted = /^>\s?(.*)$/.exec(line);
      if (quoted) {
        flushParagraph();
        flushList();
        quote.push(quoted[1]);
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flushParagraph();
        flushQuote();
        const ordered = !!numbered;
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, items: [] };
        }
        list.items.push((bullet ?? numbered)![1]);
        continue;
      }

      flushList();
      flushQuote();
      paragraph.push(line);
    }

    if (code) {
      nodes.push(
        <pre key={key++} className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[0.85em]">
          <code>{code.lines.join('\n')}</code>
        </pre>,
      );
    }
    flushAll();
    return nodes;
  }, [source]);

  return <div className={className}>{blocks}</div>;
}
