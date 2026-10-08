#!/usr/bin/env python3
"""Run keyboard/focus checks in the built native shell with disposable documents."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='cursive-focus-') as directory:
    fixture = Path(directory)
    document = fixture / 'focus.md'
    document.write_text('# 焦点测试\n\n| A | B |\n| --- | --- |\n| 中文 | 内容 |\n\n中文段落\n\n![图片](pixel.svg)\n\n$x=1+2$\n\n'
                        + r'$$\begin{aligned}a&=b+c\\d&=2\end{aligned}$$' + '\n')
    (fixture / 'pixel.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>')
    result = fixture / 'result.json'
    script = 'window.__focusResult = ' + json.dumps(str(result)) + ';\n'
    script += (root / 'test/native-focus.js').read_text()
    env = dict(os.environ, CURSIVE_SMOKE='1', CURSIVE_SMOKE_SHOT_CLEAN='1',
               CURSIVE_SMOKE_SUPPORT=str(fixture / 'support'),
               CURSIVE_SMOKE_SHOT=str(fixture / 'view.png'),
               CURSIVE_SMOKE_SHOT_WAIT='6000', CURSIVE_SMOKE_SHOT_JS=script)
    subprocess.run([str(root / 'shell-swift/cursive-shell'), str(document)],
                   cwd=root, env=env, timeout=60, check=True)
    checks = json.loads(result.read_text())
    for name, passed in checks.items():
        print(('PASS ' if passed else 'FAIL ') + name)
    assert len(checks) == 39 and all(checks.values()), checks
