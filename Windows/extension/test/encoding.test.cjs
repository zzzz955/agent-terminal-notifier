const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('PowerShell decodes Korean and tree glyphs from native UTF-8 output after a CP949 start', { skip: process.platform !== 'win32' }, () => {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const setup = path.resolve(__dirname, '../../scripts/console.ps1');
  const text = '한글 경로 ├── 파일 └─ 완료\n';
  // ASCII-only command text avoids conflating script-file encoding with output decoding.
  const nativeCode = 'process.stdout.write(Buffer.from([' + [...Buffer.from(text)].join(',') + ']))';
  const command = `[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(949); . ${quote(setup)}; & ${quote(process.execPath)} -e ${quote(nativeCode)} | Out-Host`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replaceAll('\r\n', '\n'), text);
});
