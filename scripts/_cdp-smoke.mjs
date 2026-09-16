// Minimal CDP evaluator for the running Electron renderer (temporary self-test helper).
const port = process.env.CDP_PORT || '9222'
const list = await (await fetch(`http://localhost:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  const msgId = ++id
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
await send('Runtime.enable')

const expression = process.argv[2]
const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
})
if (result.exceptionDetails) {
  console.log('EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(result.result.value, null, 2))
ws.close()
