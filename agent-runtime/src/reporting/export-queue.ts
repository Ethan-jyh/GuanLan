import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { DocumentIR } from './ir-validator.js';
import { MarkdownRenderer } from './renderers/markdown.js';
import { HtmlRenderer } from './renderers/html.js';
import { DocxRenderer } from './renderers/docx.js';
import { PdfRenderer } from './renderers/pdf.js';

export type ExportFormat = 'markdown' | 'html' | 'docx' | 'pdf';

export interface ExportAllParams {
  artifactId: string;
  documentIr: DocumentIR;
  outputDir: string;
  formats?: ExportFormat[];
}

export class ExportQueue {
  private mdRenderer = new MarkdownRenderer();
  private htmlRenderer = new HtmlRenderer();
  private docxRenderer = new DocxRenderer();
  private pdfRenderer = new PdfRenderer();

  public async exportAllFormats(
    params: ExportAllParams
  ): Promise<Record<ExportFormat, string>> {
    const { artifactId, documentIr, outputDir } = params;
    const formats = params.formats || ['markdown', 'html', 'docx', 'pdf'];

    mkdirSync(outputDir, { recursive: true });
    const results: Partial<Record<ExportFormat, string>> = {};

    for (const fmt of formats) {
      const outPath = resolve(outputDir, `${artifactId}.${fmt === 'markdown' ? 'md' : fmt}`);

      let success = false;
      let lastErr: any = null;

      // Independent retry up to 2 times for each format
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (fmt === 'markdown') {
            const content = this.mdRenderer.render(documentIr);
            writeFileSync(outPath, content, 'utf-8');
          } else if (fmt === 'html') {
            const content = this.htmlRenderer.render(documentIr);
            writeFileSync(outPath, content, 'utf-8');
          } else if (fmt === 'docx') {
            await this.docxRenderer.exportFile(documentIr, outPath);
          } else if (fmt === 'pdf') {
            await this.pdfRenderer.exportFile(documentIr, outPath);
          }
          results[fmt] = outPath;
          success = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!success) {
        throw new Error(`Failed to export format '${fmt}': ${lastErr?.message}`);
      }
    }

    return results as Record<ExportFormat, string>;
  }
}
