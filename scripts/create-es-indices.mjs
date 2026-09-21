#!/usr/bin/env node

const DEFAULT_URL = process.env.ES_URL ?? 'http://127.0.0.1:9202'
const DEFAULT_COUNT = 100
const DEFAULT_PREFIX = 'demo-index-'

function printUsage() {
  console.log(`Create Elasticsearch indices.

Usage:
  node scripts/create-es-indices.mjs [options]

Options:
  --url <url>          Elasticsearch base URL (default: ${DEFAULT_URL})
  --count <number>     Number of indices to create (default: ${DEFAULT_COUNT})
  --prefix <name>      Index name prefix (default: ${DEFAULT_PREFIX})
  --shards <number>    Primary shard count (default: 1)
  --replicas <number>  Replica count (default: 0)
  --username <name>    Basic-auth username (or use ES_USERNAME)
  --password <value>   Basic-auth password (or use ES_PASSWORD)
  --api-key <value>    Elasticsearch API key (or use ES_API_KEY)
  --help               Show this help

Examples:
  npm run es:create-test-indices
  node scripts/create-es-indices.mjs --count 100 --prefix load-test-
  ES_URL=http://localhost:9200 node scripts/create-es-indices.mjs`)
}

function readOption(argv, index, option) {
  const current = argv[index]
  const equalsIndex = current.indexOf('=')
  if (equalsIndex !== -1) {
    return { value: current.slice(equalsIndex + 1), nextIndex: index }
  }

  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return { value, nextIndex: index + 1 }
}

function parseArgs(argv) {
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (!argument.startsWith('--')) {
      throw new Error(`unknown argument: ${argument}`)
    }

    const option = argument.split('=', 1)[0]
    const parsed = readOption(argv, index, option)
    index = parsed.nextIndex

    switch (option) {
      case '--url':
        options.url = parsed.value
        break
      case '--count':
        options.count = parsed.value
        break
      case '--prefix':
        options.prefix = parsed.value
        break
      case '--shards':
        options.shards = parsed.value
        break
      case '--replicas':
        options.replicas = parsed.value
        break
      case '--username':
        options.username = parsed.value
        break
      case '--password':
        options.password = parsed.value
        break
      case '--api-key':
        options.apiKey = parsed.value
        break
      default:
        throw new Error(`unknown option: ${option}`)
    }
  }

  return options
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return parsed
}

function validatePrefix(prefix) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(prefix)) {
    throw new Error(
      'prefix must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens'
    )
  }
}

function authHeaders(options) {
  const apiKey = options.apiKey ?? process.env.ES_API_KEY
  if (apiKey) {
    return { Authorization: `ApiKey ${apiKey}` }
  }

  const username = options.username ?? process.env.ES_USERNAME
  const password = options.password ?? process.env.ES_PASSWORD
  if (!username && !password) {
    return {}
  }
  if (!username || !password) {
    throw new Error('both ES_USERNAME and ES_PASSWORD are required for basic auth')
  }
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }
}

function responseMessage(status, text) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 0 ? compact : `HTTP ${status}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const baseUrl = (options.url ?? DEFAULT_URL).replace(/\/+$/, '')
  const count = positiveInteger(options.count ?? DEFAULT_COUNT, 'count')
  const shards = positiveInteger(options.shards ?? 1, 'shards')
  const replicas = nonNegativeInteger(options.replicas ?? 0, 'replicas')
  const prefix = options.prefix ?? DEFAULT_PREFIX
  validatePrefix(prefix)

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...authHeaders(options)
  }
  const body = JSON.stringify({
    settings: {
      number_of_shards: shards,
      number_of_replicas: replicas
    }
  })

  const width = Math.max(3, String(count).length)
  let created = 0
  let skipped = 0

  for (let index = 1; index <= count; index += 1) {
    const name = `${prefix}${String(index).padStart(width, '0')}`
    const response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers,
      body,
      signal: AbortSignal.timeout(15_000)
    })
    const text = await response.text()

    if (response.ok) {
      created += 1
      console.log(`[created] ${name}`)
      continue
    }

    if (response.status === 400 && text.includes('resource_already_exists_exception')) {
      skipped += 1
      console.log(`[skipped] ${name} already exists`)
      continue
    }

    throw new Error(
      `failed to create ${name}: ${responseMessage(response.status, text)}`
    )
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped, target ${baseUrl}`)
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
