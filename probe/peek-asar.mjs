#!/usr/bin/env node
/**
 * 从 asar 中提取指定字节区间并打印（配套 asar-find.mjs 用于查看命中处的完整上下文）
 * 用法: node peek-asar.mjs <asar文件> <offset> [字节数]
 */
import { openSync, readSync } from 'node:fs'

const [file, offsetStr, lenStr] = process.argv.slice(2)
if (!file || !offsetStr) {
  console.error('usage: node peek-asar.mjs <asar> <offset> [len]')
  process.exit(2)
}
const offset = Number(offsetStr)
const len = Number(lenStr ?? 6000)
const buf = Buffer.alloc(len)
const fd = openSync(file, 'r')
readSync(fd, buf, 0, len, offset)

// 按行输出，去掉控制字符，标注相对 offset
const text = buf.toString('utf8')
let lineStart = 0
let lineNo = 0
for (const line of text.split('\n')) {
  const abs = offset + lineStart
  const clean = line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  console.log(String(abs).padStart(10) + ' │ ' + clean.slice(0, 400))
  lineStart += Buffer.byteLength(line, 'utf8') + 1
  if (++lineNo > 300) break
}
