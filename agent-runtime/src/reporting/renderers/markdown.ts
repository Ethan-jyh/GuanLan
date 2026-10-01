import { DocumentIR, ChapterIR } from '../ir-validator.js';

export class MarkdownRenderer {
  public render(documentIr: DocumentIR): string {
    const lines: string[] = [];

    const meta = documentIr.metadata || {};
    const title = meta.title || '舆情情报研判专报';
    lines.push(`# ${title}`);
    lines.push('');

    if (meta.reportId || meta.generatedAt) {
      const parts = [];
      if (meta.reportId) parts.push(`报告编号：${meta.reportId}`);
      if (meta.generatedAt) parts.push(`生成时间：${meta.generatedAt}`);
      lines.push(`*${parts.join(' | ')}*`);
      lines.push('');
    }

    const chapters = (documentIr.chapters || []).slice().sort((a, b) => a.order - b.order);
    for (const ch of chapters) {
      lines.push(`## ${ch.title}`);
      lines.push('');

      for (const block of ch.blocks || []) {
        this.renderBlock(block, lines);
      }
    }

    return lines.join('\n');
  }

  private renderBlock(block: any, lines: string[]): void {
    if (!block) return;

    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, (block.level || 2) + 1);
        const prefix = '#'.repeat(level);
        lines.push(`${prefix} ${block.text}`);
        lines.push('');
        break;
      }
      case 'paragraph': {
        const text = this.renderInlines(block.inlines || []);
        lines.push(text);
        lines.push('');
        break;
      }
      case 'list': {
        const listType = block.listType || 'bullet';
        const items = block.items || [];
        for (let i = 0; i < items.length; i++) {
          const itemBlocks = items[i] || [];
          const prefix = listType === 'ordered' ? `${i + 1}. ` : '* ';
          for (const sub of itemBlocks) {
            if (sub.type === 'paragraph') {
              lines.push(`${prefix}${this.renderInlines(sub.inlines || [])}`);
            }
          }
        }
        lines.push('');
        break;
      }
      case 'blockquote':
      case 'engineQuote': {
        const inner = block.blocks || [];
        for (const sub of inner) {
          if (sub.type === 'paragraph') {
            lines.push(`> ${this.renderInlines(sub.inlines || [])}`);
          }
        }
        lines.push('');
        break;
      }
      case 'table': {
        const rows = block.rows || [];
        if (rows.length > 0) {
          for (let rIdx = 0; rIdx < rows.length; rIdx++) {
            const cells = rows[rIdx].cells || [];
            const cellTexts = cells.map((c: any) => {
              const p = (c.blocks || []).find((b: any) => b.type === 'paragraph');
              return p ? this.renderInlines(p.inlines || []) : '';
            });
            lines.push(`| ${cellTexts.join(' | ')} |`);

            if (rIdx === 0) {
              const divider = cells.map(() => '---').join(' | ');
              lines.push(`| ${divider} |`);
            }
          }
          lines.push('');
        }
        break;
      }
      default:
        break;
    }
  }

  private renderInlines(inlines: any[]): string {
    return inlines
      .map((item) => {
        let text = item.text || '';
        const marks = new Set((item.marks || []).map((m: any) => (typeof m === 'string' ? m : m.type)));
        if (marks.has('bold')) text = `**${text}**`;
        if (marks.has('italic')) text = `*${text}*`;
        if (marks.has('code')) text = `\`${text}\``;
        return text;
      })
      .join('');
  }
}
