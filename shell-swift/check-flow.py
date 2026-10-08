#!/usr/bin/env python3
"""第八节 5–7 的核心流程（只读 / 后退前进 / 重新打开关闭的标签）在真窗口里跑一遍，夹具用完即弃。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
CHECKS = 30

with tempfile.TemporaryDirectory(prefix='cursive-flow-') as directory:
    fixture = Path(directory)
    filler = '\n\n'.join(f'第 {i} 段正文，撑出滚动的高度。' for i in range(1, 70))
    (fixture / 'a.md').write_text(
        '# A 文档\n\n开头一段。[去 B 的第二节](b.md#第二节)\n\n- [ ] 待办一项\n\n'
        '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n![图](pixel.svg)\n\n'
        f'## 远处的一节\n\n{filler}\n\n## 最后一节\n\n结尾一段。\n')
    (fixture / 'b.md').write_text(f'# B 文档\n\n## 第一节\n\n{filler}\n\n## 第二节\n\n第二节正文。\n')
    (fixture / 'pixel.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>')
    result = fixture / 'result.json'
    script = 'window.__flowResult = ' + json.dumps(str(result)) + ';\n'
    script += (root / 'test/native-flow.js').read_text()
    env = dict(os.environ, CURSIVE_SMOKE='1', CURSIVE_SMOKE_SHOT_CLEAN='1',
               CURSIVE_SMOKE_SUPPORT=str(fixture / 'support'),
               CURSIVE_SMOKE_SHOT=str(fixture / 'view.png'),
               CURSIVE_SMOKE_SHOT_WAIT='15000', CURSIVE_SMOKE_SHOT_JS=script)
    subprocess.run([str(root / 'shell-swift/cursive-shell'), str(fixture / 'a.md')],
                   cwd=root, env=env, timeout=90, check=True)
    checks = json.loads(result.read_text())
    for name, passed in checks.items():
        if name == 'errorText':
            print('ERROR ' + passed)
            continue
        print(('PASS ' if passed else 'FAIL ') + name)
    assert len(checks) == CHECKS and all(checks.values()), checks
