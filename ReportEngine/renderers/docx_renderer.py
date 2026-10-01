# -*- coding: utf-8 -*-
"""
ReportEngine DOCX 专报文档渲染器 (DocxRenderer)
将 Document IR 转换为符合党政及实验室专报格式规范的 Word (.docx) 文件。
支持标题层级、正文行距、列表、表格、引用块及页眉页脚装订。
"""

import os
from typing import Dict, Any, List, Optional
from loguru import logger

try:
    import docx
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False


class DocxRenderer:
    """Document IR 到 DOCX 的高保真渲染器"""

    def __init__(self):
        if not DOCX_AVAILABLE:
            logger.warning("python-docx 未安装，DOCX 渲染功能不可用。请通过 pip install python-docx 安装。")

    def export_file(self, document_ir: Dict[str, Any], output_path: str) -> str:
        """
        导出并保存为 .docx 文件
        """
        doc = self.render(document_ir)
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        doc.save(output_path)
        return output_path

    def render(self, document_ir: Dict[str, Any]) -> "docx.Document":
        """
        核心渲染方法：解析 Document IR 并构建 docx.Document 对象
        """
        if not DOCX_AVAILABLE:
            raise RuntimeError("python-docx is not installed")

        doc = docx.Document()
        self._configure_page_setup(doc)

        metadata = document_ir.get("metadata", {})
        title = metadata.get("title") or "舆情情报专项研判报告"

        # 1. 渲染大标题
        title_p = doc.add_paragraph()
        title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        title_p.paragraph_format.space_before = Pt(12)
        title_p.paragraph_format.space_after = Pt(18)
        run = title_p.add_run(title)
        run.font.size = Pt(22)
        run.font.bold = True
        run.font.name = "Microsoft YaHei"
        rPr = run._r.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            rFonts = OxmlElement("w:rFonts")
            rPr.append(rFonts)
        rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")


        # 2. 渲染元数据副标题
        gen_time = metadata.get("generatedAt", "")
        if gen_time:
            meta_p = doc.add_paragraph()
            meta_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            meta_p.paragraph_format.space_after = Pt(20)
            meta_run = meta_p.add_run(f"报告编号：{metadata.get('reportId', 'N/A')}  |  生成时间：{gen_time[:19]}")
            meta_run.font.size = Pt(10)
            meta_run.font.color.rgb = RGBColor(120, 120, 120)

        # 3. 逐章节渲染
        chapters = document_ir.get("chapters", [])
        ordered_chapters = sorted(chapters, key=lambda c: c.get("order", 0))

        for chapter in ordered_chapters:
            self._render_chapter(doc, chapter)

        return doc

    def _configure_page_setup(self, doc: "docx.Document"):
        """设置标准 A4 版心页边距与默认样式"""
        sections = doc.sections
        for section in sections:
            section.page_width = Inches(8.27)   # A4 宽度
            section.page_height = Inches(11.69) # A4 高度
            section.top_margin = Inches(1.0)
            section.bottom_margin = Inches(1.0)
            section.left_margin = Inches(1.1)
            section.right_margin = Inches(1.1)

    def _render_chapter(self, doc: "docx.Document", chapter: Dict[str, Any]):
        """渲染单个章节及其包含的所有区块"""
        ch_title = chapter.get("title")
        if ch_title:
            ch_p = doc.add_paragraph()
            ch_p.paragraph_format.space_before = Pt(14)
            ch_p.paragraph_format.space_after = Pt(8)
            ch_run = ch_p.add_run(ch_title)
            ch_run.font.size = Pt(16)
            ch_run.font.bold = True
            ch_run.font.color.rgb = RGBColor(26, 54, 93)  # 深蓝典雅标色

        blocks = chapter.get("blocks", [])
        for block in blocks:
            self._render_block(doc, block)

    def _render_block(self, doc: "docx.Document", block: Dict[str, Any]):
        """根据 block 类型分发渲染"""
        btype = block.get("type")

        if btype == "heading":
            level = block.get("level", 2)
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.space_after = Pt(4)
            r = p.add_run(block.get("text", ""))
            r.font.bold = True
            r.font.size = Pt(14 if level <= 2 else 12)
            if level <= 2:
                r.font.color.rgb = RGBColor(43, 76, 126)

        elif btype == "paragraph":
            p = doc.add_paragraph()
            p.paragraph_format.line_spacing = 1.25
            p.paragraph_format.space_after = Pt(5)
            inlines = block.get("inlines", [])
            for run_data in inlines:
                r = p.add_run(run_data.get("text", ""))
                r.font.size = Pt(11)
                marks = run_data.get("marks", [])
                for mark in marks:
                    mtype = mark.get("type") if isinstance(mark, dict) else mark
                    if mtype == "bold":
                        r.font.bold = True
                    elif mtype == "italic":
                        r.font.italic = True
                    elif mtype == "underline":
                        r.font.underline = True

        elif btype == "list":
            list_type = block.get("listType", "bullet")
            items = block.get("items", [])
            for item in items:
                # item 是 block 数组
                for sub_b in item:
                    if sub_b.get("type") == "paragraph":
                        style_name = "List Bullet" if list_type == "bullet" else "List Number"
                        p = doc.add_paragraph(style=style_name)
                        p.paragraph_format.line_spacing = 1.2
                        p.paragraph_format.space_after = Pt(3)
                        for rdata in sub_b.get("inlines", []):
                            r = p.add_run(rdata.get("text", ""))
                            r.font.size = Pt(10.5)
                            marks = rdata.get("marks", [])
                            for m in marks:
                                mt = m.get("type") if isinstance(m, dict) else m
                                if mt == "bold":
                                    r.font.bold = True

        elif btype == "blockquote" or btype == "engineQuote":
            inner_blocks = block.get("blocks", [])
            for ib in inner_blocks:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Inches(0.4)
                p.paragraph_format.line_spacing = 1.2
                p.paragraph_format.space_after = Pt(4)
                for rdata in ib.get("inlines", []):
                    r = p.add_run(rdata.get("text", ""))
                    r.font.size = Pt(10.5)
                    r.font.italic = True
                    r.font.color.rgb = RGBColor(90, 90, 90)

        elif btype == "table":
            rows_data = block.get("rows", [])
            if rows_data:
                num_rows = len(rows_data)
                num_cols = len(rows_data[0].get("cells", [])) if num_rows > 0 else 0
                if num_rows > 0 and num_cols > 0:
                    tbl = doc.add_table(rows=num_rows, cols=num_cols)
                    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
                    for r_idx, row in enumerate(rows_data):
                        cells = row.get("cells", [])
                        for c_idx, cell in enumerate(cells):
                            if c_idx < num_cols:
                                cell_obj = tbl.cell(r_idx, c_idx)
                                cell_blocks = cell.get("blocks", [])
                                text_content = []
                                for cb in cell_blocks:
                                    for rin in cb.get("inlines", []):
                                        text_content.append(rin.get("text", ""))
                                cell_obj.text = " ".join(text_content)
                                if r_idx == 0:
                                    for p in cell_obj.paragraphs:
                                        for r in p.runs:
                                            r.font.bold = True
                                            r.font.size = Pt(10.5)
                    doc.add_paragraph().paragraph_format.space_after = Pt(6)
