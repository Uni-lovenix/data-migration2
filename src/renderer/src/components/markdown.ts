/**
 * 轻量级 Markdown → HTML 渲染（仅支持 Agent Chat 输出所需子集）
 * - 代码块（```lang...```）
 * - 行内代码（`x`）
 * - 粗体 **x**、斜体 *x*
 * - 链接 [text](url)
 * - 标题 # / ## / ###
 * - 无序列表 - / *
 * - 有序列表 1. 2.
 * - 表格（| col | col |）
 * - 引用 >
 *
 * 安全策略：所有 HTML 特殊字符先转义，再做轻量替换。
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inlineFormat(text: string): string {
  // 行内代码
  let html = text.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 斜体
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  // 链接 [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  )
  return html
}

export function renderMarkdown(source: string): string {
  if (!source) return ''
  const escaped = escapeHtml(source)
  const lines = escaped.split('\n')
  const output: string[] = []
  let inCode = false
  let codeBuffer: string[] = []
  let codeLang = ''
  let inList: 'ul' | 'ol' | null = null
  let inTable = false
  let tableBuffer: string[] = []

  const flushList = (): void => {
    if (inList) {
      output.push(`</${inList}>`)
      inList = null
    }
  }
  const flushTable = (): void => {
    if (inTable) {
      output.push(renderTable(tableBuffer))
      tableBuffer = []
      inTable = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine

    // 代码块
    if (line.trim().startsWith('```')) {
      flushList()
      flushTable()
      if (inCode) {
        output.push(`<pre><code class="lang-${codeLang}">${codeBuffer.join('\n')}</code></pre>`)
        inCode = false
        codeBuffer = []
        codeLang = ''
      } else {
        inCode = true
        codeLang = line.trim().slice(3).trim()
      }
      continue
    }
    if (inCode) {
      codeBuffer.push(line)
      continue
    }

    // 表格（简单 GFM）
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      flushList()
      inTable = true
      tableBuffer.push(line)
      continue
    } else if (inTable) {
      flushTable()
    }

    // 标题
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = heading[1]?.length ?? 1
      output.push(`<h${level}>${inlineFormat(heading[2] ?? '')}</h${level}>`)
      continue
    }

    // 无序列表
    const ulMatch = /^\s*[-*]\s+(.*)$/.exec(line)
    if (ulMatch) {
      if (inList !== 'ul') {
        flushList()
        output.push('<ul>')
        inList = 'ul'
      }
      output.push(`<li>${inlineFormat(ulMatch[1] ?? '')}</li>`)
      continue
    }

    // 有序列表
    const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (olMatch) {
      if (inList !== 'ol') {
        flushList()
        output.push('<ol>')
        inList = 'ol'
      }
      output.push(`<li>${inlineFormat(olMatch[1] ?? '')}</li>`)
      continue
    }

    if (inList) flushList()

    // 引用
    const quoteMatch = /^>\s+(.*)$/.exec(line)
    if (quoteMatch) {
      output.push(`<blockquote>${inlineFormat(quoteMatch[1] ?? '')}</blockquote>`)
      continue
    }

    // 空行
    if (line.trim().length === 0) {
      output.push('')
      continue
    }

    // 普通段落
    output.push(`<p>${inlineFormat(line)}</p>`)
  }
  flushList()
  flushTable()
  if (inCode) {
    output.push(`<pre><code class="lang-${codeLang}">${codeBuffer.join('\n')}</code></pre>`)
  }

  return output.join('\n')
}

function renderTable(rows: string[]): string {
  if (rows.length === 0) return ''
  const splitRow = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  const header = splitRow(rows[0] ?? '')
  const lines: string[] = ['<table><thead><tr>']
  for (const cell of header) {
    lines.push(`<th>${inlineFormat(cell)}</th>`)
  }
  lines.push('</tr></thead><tbody>')

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    if (/^\s*\|?\s*[-: ]+\s*(\|\s*[-: ]+\s*)+\|?\s*$/.test(row)) {
      // 分隔行 | --- | --- |
      continue
    }
    const cells = splitRow(row)
    lines.push('<tr>')
    for (const cell of cells) {
      lines.push(`<td>${inlineFormat(cell)}</td>`)
    }
    lines.push('</tr>')
  }
  lines.push('</tbody></table>')
  return lines.join('')
}
