export const ALLOWED_BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'list',
  'table',
  'swotTable',
  'pestTable',
  'blockquote',
  'engineQuote',
  'hr',
  'code',
  'callout',
]);

export interface ChapterIR {
  chapterId: string;
  title: string;
  anchor: string;
  order: number;
  blocks: any[];
}

export interface DocumentIR {
  schemaVersion?: string;
  metadata?: {
    reportId?: string;
    title?: string;
    generatedAt?: string;
    [key: string]: any;
  };
  chapters: ChapterIR[];
}

export class IRValidator {
  constructor(public schemaVersion = '1.0') {}

  public validateChapter(chapter: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!chapter || typeof chapter !== 'object') {
      return { valid: false, errors: ['chapter must be an object'] };
    }

    for (const field of ['chapterId', 'title', 'anchor', 'order', 'blocks']) {
      if (!(field in chapter)) {
        errors.push(`missing chapter.${field}`);
      }
    }

    if (!Array.isArray(chapter.blocks) || chapter.blocks.length === 0) {
      errors.push('chapter.blocks must be a non-empty array');
      return { valid: false, errors };
    }

    for (let idx = 0; idx < chapter.blocks.length; idx++) {
      this.validateBlock(chapter.blocks[idx], `blocks[${idx}]`, errors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  public validateDocument(doc: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!doc || typeof doc !== 'object') {
      return { valid: false, errors: ['Document must be an object'] };
    }

    if (!doc.metadata || typeof doc.metadata !== 'object') {
      errors.push('missing document.metadata');
    }

    if (!Array.isArray(doc.chapters) || doc.chapters.length === 0) {
      errors.push('document.chapters must be a non-empty array');
      return { valid: false, errors };
    }

    for (let i = 0; i < doc.chapters.length; i++) {
      const res = this.validateChapter(doc.chapters[i]);
      for (const err of res.errors) {
        errors.push(`chapters[${i}]: ${err}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private validateBlock(block: any, path: string, errors: string[]) {
    if (!block || typeof block !== 'object') {
      errors.push(`${path} must be an object`);
      return;
    }

    const type = block.type;
    if (!type || !ALLOWED_BLOCK_TYPES.has(type)) {
      errors.push(`${path}.type unsupported: ${type}`);
      return;
    }

    if (type === 'heading') {
      if (typeof block.level !== 'number') errors.push(`${path}.level must be an integer`);
      if (!block.text) errors.push(`${path}.text missing`);
      if (!block.anchor) errors.push(`${path}.anchor missing`);
    } else if (type === 'paragraph') {
      if (!Array.isArray(block.inlines) || block.inlines.length === 0) {
        errors.push(`${path}.inlines must be a non-empty array`);
      }
    } else if (type === 'table') {
      if (!Array.isArray(block.rows)) {
        errors.push(`${path}.rows must be an array`);
      }
    }
  }
}
