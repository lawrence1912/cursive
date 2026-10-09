#!/usr/bin/env python3
"""第八节 12 的 PDF 走查：宽表格、长代码行、标题与正文分页，在真的打印路径上印一份看。

夹具现写（用完即弃），**只导 PDF、不跑探针**（`CURSIVE_SMOKE_PDF_ONLY`：探针会改文档，
走查要看的是文档原原本本印出来的样子）。每页的文字由壳用 PDFKit 抽出来（`CURSIVE_SMOKE_PDF_TEXT`），
所以夹具全用英文 —— PDFKit 抽中文会失真。三条断言：

  · **没有一页以标题收尾**。夹具里每一节的第一段都是正好三行的段落：orphans / widows 都是 3，
    这种段落拆不开、只能整段挪页，WebKit 这时不守标题的 `break-after: avoid`。
    修之前同一份夹具（随机种子 1）有四页以标题收尾；
  · **宽表格最右一列印出来了**。一条不带空格的长网址曾经把那一列撑死，整张表比纸宽：
    右边两列整列消失，而且 WebKit 为了迁就它把整份文档等比缩小着印；
  · **长代码行一个字符不少**（纸上没有横向滚动条，折行而不是裁掉）。

    python3 shell-swift/check-pdf.py
"""
import json
import os
from pathlib import Path
import random
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
CHECKS = 4
HEADING = re.compile(r'^(Section \d+|Wide table|Long code lines|PDF Walkthrough)$')
BLOB = 'A1b2C3d4' * 40


def fixture(path: Path, seed: int) -> None:
    rng = random.Random(seed)
    lines = ['# PDF Walkthrough', '', '## Wide table', '',
             '| Column A | Column B | Column C | Column D | Column E | Column F | Column G | Column H |',
             '| --- | --- | --- | --- | --- | --- | --- | --- |']
    url = 'https://example.com/a/very/long/url/without/any/spaces/that/keeps/going/and/going/forever/index.html'
    for r in range(6):
        lines.append(f'| row {r} | a much longer cell that has several words in it | {url} | {12345 + r} '
                     f'| 中文单元格里一段比较长的文字，用来撑宽 | `inline_code_value_{r}` | yes | end{r} |')
    lines += ['', '## Long code lines', '', '```ts', f"const blob = '{BLOB}'",
              'const spaced = ' + ' '.join(f'word{i}' for i in range(60)), '```', '']
    filler = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
              'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.')
    for i in range(1, 101):
        # 每节第一段正好三行：标题被它留在页底的那种情形，靠这一段才稳定撞得上
        lines += [f'## Section {i}', '', filler * 3, '']
        for _ in range(rng.randint(0, 3)):
            lines += [filler * rng.randint(1, 2), '']
    path.write_text('\n'.join(lines) + '\n')


with tempfile.TemporaryDirectory(prefix='cursive-pdf-') as directory:
    d = Path(directory)
    doc = d / 'walk.md'
    fixture(doc, 1)
    out = Path('/tmp/cursive-shell-pdf.json')
    out.unlink(missing_ok=True)
    env = dict(os.environ, CURSIVE_SMOKE='1', CURSIVE_SMOKE_PDF_ONLY='1', CURSIVE_SMOKE_PDF_TEXT='1',
               CURSIVE_SMOKE_SUPPORT=str(d / 'support'), CURSIVE_SMOKE_PDF=str(d / 'walk.pdf'))
    subprocess.run([str(root / 'shell-swift/cursive-shell'), str(doc)], cwd=root, env=env, timeout=120, check=True)
    result = json.loads(out.read_text())
    pages = result.get('pageText') or []
    tails = []
    for text in pages:
        body = [line.strip() for line in text.splitlines() if line.strip()]
        tails.append(body[-1] if body else '')
    orphans = [(i + 1, tail) for i, tail in enumerate(tails) if HEADING.match(tail)]
    flat = re.sub(r'\s+', '', ''.join(pages))
    checks = {
        'PDF 印出来了（A4、好几页）': not result.get('error') and result.get('width') == 595 and len(pages) >= 10,
        '没有一页以标题收尾 %s' % orphans: not orphans,
        # 表头在纸上会折成「Column / H」两行，比之前先去掉空白
        '宽表格最右一列印出来了（没被裁掉，也没把整份文档缩小）':
            'ColumnH' in re.sub(r'\s+', '', pages[0]) and 'end5' in re.sub(r'\s+', '', ''.join(pages[:2])),
        '长代码行一个字符不少': BLOB in flat,
    }
    for name, passed in checks.items():
        print(('PASS ' if passed else 'FAIL ') + name)
    assert len(checks) == CHECKS and all(checks.values()), checks
