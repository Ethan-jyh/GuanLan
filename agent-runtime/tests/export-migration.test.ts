import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { MarkdownRenderer } from '../src/reporting/renderers/markdown.js';
import { HtmlRenderer } from '../src/reporting/renderers/html.js';
import { DocxRenderer } from '../src/reporting/renderers/docx.js';
import { PdfRenderer } from '../src/reporting/renderers/pdf.js';
import { ExportQueue } from '../src/reporting/export-queue.js';

describe('Task 6B: Markdown, HTML, DOCX, and PDF Renderers & Export Queue', () => {
  const sampleDocumentIr = {
    schemaVersion: '1.0',
    metadata: {
      reportId: 'rep-20261001-001',
      title: '暴雨应急处置与舆情研判专报',
      generatedAt: '2026-10-01T12:00:00Z',
    },
    chapters: [
      {
        chapterId: 'ch-01',
        title: '一、核心态势与处置评估',
        anchor: 'sec-1',
        order: 1,
        blocks: [
          {
            type: 'heading',
            level: 2,
            text: '1. 应急响应与伤亡排查',
            anchor: 'sec-1-1',
          },
          {
            type: 'paragraph',
            inlines: [
              { text: '市应急管理局已启动防汛二级响应，', marks: ['bold'] },
              { text: '截至目前未发生人员失联伤亡。' },
            ],
          },
          {
            type: 'table',
            rows: [
              {
                cells: [
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '维度' }] }] },
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '现状' }] }] },
                ],
              },
              {
                cells: [
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '防汛级别' }] }] },
                  { blocks: [{ type: 'paragraph', inlines: [{ text: '二级' }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  describe('MarkdownRenderer', () => {
    it('should render Document IR to valid GFM Markdown', () => {
      const renderer = new MarkdownRenderer();
      const md = renderer.render(sampleDocumentIr);

      assert.ok(md.includes('# 暴雨应急处置与舆情研判专报'));
      assert.ok(md.includes('## 一、核心态势与处置评估'));
      assert.ok(md.includes('### 1. 应急响应与伤亡排查'));
      assert.ok(md.includes('**市应急管理局已启动防汛二级响应，**'));
      assert.ok(md.includes('| 维度 | 现状 |'));
    });
  });

  describe('HtmlRenderer', () => {
    it('should render Document IR to styled standalone HTML', () => {
      const renderer = new HtmlRenderer();
      const html = renderer.render(sampleDocumentIr);

      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('<h1>暴雨应急处置与舆情研判专报</h1>'));
      assert.ok(html.includes('<h2>一、核心态势与处置评估</h2>'));
      assert.ok(html.includes('<strong>市应急管理局已启动防汛二级响应，</strong>'));
      assert.ok(html.includes('<table>'));
    });
  });

  describe('DocxRenderer', () => {
    it('should export valid DOCX file', async () => {
      const renderer = new DocxRenderer();
      const outputPath = resolve(tmpdir(), `test-report-${Date.now()}.docx`);

      await renderer.exportFile(sampleDocumentIr, outputPath);
      assert.ok(existsSync(outputPath));

      const fileBuffer = readFileSync(outputPath);
      // PK signature for zip / docx format is 0x50 0x4B 0x03 0x04
      assert.equal(fileBuffer[0], 0x50);
      assert.equal(fileBuffer[1], 0x4b);

      try {
        unlinkSync(outputPath);
      } catch {}
    });
  });

  describe('PdfRenderer', () => {
    it('should render printable HTML/PDF output buffer', async () => {
      const renderer = new PdfRenderer();
      const outputPath = resolve(tmpdir(), `test-report-${Date.now()}.pdf`);

      const resultPath = await renderer.exportFile(sampleDocumentIr, outputPath);
      assert.ok(existsSync(resultPath));

      try {
        unlinkSync(resultPath);
      } catch {}
    });
  });

  describe('ExportQueue: Retries without re-running Agent', () => {
    it('should manage export jobs and record outputs', async () => {
      const queue = new ExportQueue();
      const outDir = resolve(tmpdir(), `export-run-${Date.now()}`);

      const result = await queue.exportAllFormats({
        artifactId: 'art-001',
        documentIr: sampleDocumentIr,
        outputDir: outDir,
        formats: ['markdown', 'html', 'docx', 'pdf'],
      });

      assert.ok(result.markdown && existsSync(result.markdown));
      assert.ok(result.html && existsSync(result.html));
      assert.ok(result.docx && existsSync(result.docx));
      assert.ok(result.pdf && existsSync(result.pdf));
    });
  });
});
