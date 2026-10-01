import { DocumentIR } from '../ir-validator.js';

export class HtmlRenderer {
  public render(documentIr: DocumentIR): string {
    const meta = documentIr.metadata || {};
    const title = this.escape(meta.title || '舆情情报研判专报');
    const reportId = this.escape(meta.reportId || '');
    const genTime = this.escape(meta.generatedAt || '');

    const bodyParts: string[] = [];

    // Header banner
    bodyParts.push(`<header class="report-header">`);
    bodyParts.push(`  <h1>${title}</h1>`);
    if (reportId || genTime) {
      bodyParts.push(`  <div class="report-meta">报告编号：${reportId} | 生成时间：${genTime}</div>`);
    }
    bodyParts.push(`</header>`);

    const chapters = (documentIr.chapters || []).slice().sort((a, b) => a.order - b.order);
    for (const ch of chapters) {
      bodyParts.push(`<section class="report-chapter" id="${this.escape(ch.anchor || ch.chapterId)}">`);
      bodyParts.push(`  <h2>${this.escape(ch.title)}</h2>`);
      for (const block of ch.blocks || []) {
        bodyParts.push(this.renderBlock(block));
      }
      bodyParts.push(`</section>`);
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      color: #24292e;
      background-color: #f6f8fa;
      margin: 0;
      padding: 2rem 1rem;
    }
    .report-container {
      max-width: 900px;
      margin: 0 auto;
      background: #ffffff;
      padding: 3rem 3.5rem;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
    }
    .report-header {
      text-align: center;
      border-bottom: 2px solid #eaecef;
      padding-bottom: 1.5rem;
      margin-bottom: 2.5rem;
    }
    .report-header h1 {
      font-size: 2rem;
      color: #0f2d59;
      margin-bottom: 0.5rem;
    }
    .report-meta {
      font-size: 0.9rem;
      color: #586069;
    }
    .report-chapter h2 {
      font-size: 1.4rem;
      color: #1a365d;
      border-left: 4px solid #3182ce;
      padding-left: 0.75rem;
      margin-top: 2rem;
      margin-bottom: 1rem;
    }
    h3 { font-size: 1.15rem; color: #2b4c7e; margin-top: 1.5rem; }
    p { margin: 0.8rem 0; font-size: 1.02rem; line-height: 1.7; }
    blockquote {
      border-left: 4px solid #cbd5e0;
      color: #4a5568;
      background-color: #f7fafc;
      padding: 0.75rem 1.25rem;
      margin: 1rem 0;
      border-radius: 0 4px 4px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      font-size: 0.95rem;
    }
    th, td {
      border: 1px solid #e2e8f0;
      padding: 0.75rem 1rem;
      text-align: left;
    }
    th {
      background-color: #edf2f7;
      font-weight: 600;
      color: #2d3748;
    }
    ul, ol { padding-left: 1.5rem; margin: 0.8rem 0; }
    li { margin: 0.4rem 0; }
  </style>
</head>
<body>
  <div class="report-container">
    ${bodyParts.join('\n')}
  </div>
</body>
</html>`;
  }

  private renderBlock(block: any): string {
    if (!block) return '';
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.level || 2));
        return `<h${level} id="${this.escape(block.anchor || '')}">${this.escape(block.text || '')}</h${level}>`;
      }
      case 'paragraph': {
        return `<p>${this.renderInlines(block.inlines || [])}</p>`;
      }
      case 'list': {
        const tag = block.listType === 'ordered' ? 'ol' : 'ul';
        const items = (block.items || []).map((item: any[]) => {
          const content = item.map((b) => this.renderBlock(b)).join('');
          return `<li>${content}</li>`;
        });
        return `<${tag}>${items.join('')}</${tag}>`;
      }
      case 'blockquote':
      case 'engineQuote': {
        const inner = (block.blocks || []).map((b: any) => this.renderBlock(b)).join('');
        return `<blockquote>${inner}</blockquote>`;
      }
      case 'table': {
        const rows = (block.rows || []).map((row: any, rIdx: number) => {
          const cellTag = rIdx === 0 ? 'th' : 'td';
          const cells = (row.cells || []).map((cell: any) => {
            const content = (cell.blocks || []).map((b: any) => this.renderBlock(b)).join('');
            return `<${cellTag}>${content}</${cellTag}>`;
          });
          return `<tr>${cells.join('')}</tr>`;
        });
        return `<table>${rows.join('')}</table>`;
      }
      default:
        return '';
    }
  }

  private renderInlines(inlines: any[]): string {
    return inlines
      .map((item) => {
        let text = this.escape(item.text || '');
        const marks = new Set((item.marks || []).map((m: any) => (typeof m === 'string' ? m : m.type)));
        if (marks.has('bold')) text = `<strong>${text}</strong>`;
        if (marks.has('italic')) text = `<em>${text}</em>`;
        if (marks.has('code')) text = `<code>${text}</code>`;
        return text;
      })
      .join('');
  }

  private escape(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
