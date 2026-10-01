import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  WidthType,
  Packer,
} from 'docx';

import { DocumentIR } from '../ir-validator.js';

export class DocxRenderer {
  public async exportFile(documentIr: DocumentIR, outputPath: string): Promise<string> {
    const doc = this.buildDocument(documentIr);
    const buffer = await Packer.toBuffer(doc);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, buffer);
    return outputPath;
  }

  public buildDocument(documentIr: DocumentIR): Document {
    const meta = documentIr.metadata || {};
    const title = meta.title || '舆情情报研判专报';
    const children: any[] = [];

    // Title
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
      })
    );

    // Metadata
    if (meta.reportId || meta.generatedAt) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `报告编号：${meta.reportId || 'N/A'} | 生成时间：${meta.generatedAt || ''}`,
              color: '777777',
              size: 20, // 10pt
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        })
      );
    }

    const chapters = (documentIr.chapters || []).slice().sort((a, b) => a.order - b.order);
    for (const ch of chapters) {
      // Chapter heading
      children.push(
        new Paragraph({
          text: ch.title,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        })
      );

      for (const block of ch.blocks || []) {
        this.renderBlock(block, children);
      }
    }

    return new Document({
      sections: [
        {
          properties: {},
          children,
        },
      ],
    });
  }

  private renderBlock(block: any, children: any[]): void {
    if (!block) return;

    switch (block.type) {
      case 'heading': {
        const level = block.level || 2;
        const heading =
          level === 1
            ? HeadingLevel.HEADING_1
            : level === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3;

        children.push(
          new Paragraph({
            text: block.text || '',
            heading,
            spacing: { before: 240, after: 120 },
          })
        );
        break;
      }
      case 'paragraph': {
        const runs = (block.inlines || []).map((item: any) => {
          const marks = new Set((item.marks || []).map((m: any) => (typeof m === 'string' ? m : m.type)));
          return new TextRun({
            text: item.text || '',
            bold: marks.has('bold'),
            italics: marks.has('italic'),
            size: 22, // 11pt
          });
        });

        children.push(
          new Paragraph({
            children: runs,
            spacing: { after: 160 },
          })
        );
        break;
      }
      case 'table': {
        const rows = (block.rows || []).map((row: any, rIdx: number) => {
          const cells = (row.cells || []).map((cell: any) => {
            const paragraphs = (cell.blocks || []).map((b: any) => {
              const runs = (b.inlines || []).map((inl: any) => {
                const marks = new Set((inl.marks || []).map((m: any) => (typeof m === 'string' ? m : m.type)));
                return new TextRun({
                  text: inl.text || '',
                  bold: rIdx === 0 || marks.has('bold'),
                  size: 20, // 10pt
                });
              });
              return new Paragraph({ children: runs });
            });

            return new TableCell({
              children: paragraphs.length > 0 ? paragraphs : [new Paragraph({})],
              width: { size: 4500, type: WidthType.DXA },
            });
          });

          return new TableRow({ children: cells });
        });

        if (rows.length > 0) {
          children.push(
            new Table({
              rows,
              alignment: AlignmentType.CENTER,
            })
          );
          children.push(new Paragraph({ spacing: { after: 200 } }));
        }
        break;
      }
      default:
        break;
    }
  }
}
