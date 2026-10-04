#!/usr/bin/env node
// Generates TOOLS.md from the live MCP `tools/list` of Brainy Prices (https://prices.brainy.ae/mcp/v2).
// No dependencies: Node.js 18+ (global fetch). Usage:
//   node scripts/gen-tools.mjs [--url https://prices.brainy.ae/mcp/v2] [--out TOOLS.md]
// Requests are sequential and at least 1.1 s apart; an HTTP 429 stops the run. Nothing is written unless every page was read.
// Exit codes: 0 ok, 1 HTTP/network/protocol error, 2 JSON-RPC error, 4 rate limited (429), 5 timeout.
import { writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ENDPOINT = option('--url') ?? 'https://prices.brainy.ae/mcp/v2';
const OUT = resolve(option('--out') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'TOOLS.md'));
const PROTOCOL = '2025-11-25';
const SPACING_MS = 1100, TIMEOUT_MS = 20000, MAX_PAGES = 20;

// Same groups, in the same order, as https://prices.brainy.ae/developers.html. A tool that matches none goes to "Other".
const GROUPS = [
  ['Groceries', name => /^(?:grocery_|shopper_)|_shop_prices$/.test(name)],
  ['Schools', name => name === 'schools'],
  ['Housing and household costs', name => ['housing_rents', 'housing_sales', 'costs_by_area', 'fixed_monthly_costs', 'costs_by_emirate', 'tax_savings_by_country'].includes(name)],
  ['Transport and utilities', name => ['fuel_prices', 'transport_fares', 'commute_cost', 'dewa', 'mobile_internet_plans'].includes(name)],
  ['Health and relocation', name => ['health_insurance', 'residence_visas', 'free_zone_companies', 'move_to_dubai', 'fx_rates'].includes(name)],
  ['Highlights and sources', name => ['today', 'data_sources'].includes(name)]
];

// The only two wording changes made to descriptions; TOOLS.md states them. Everything else is copied verbatim.
const NORMALIZATIONS = [
  { from: /\bfamily-\u0069ndex\b/gi, to: 'household' },
  { from: /\barea \u0072anks\b/gi, to: 'area cost comparisons' }
];
function normalize(text) {
  let out = String(text ?? ''), count = 0;
  for (const { from, to } of NORMALIZATIONS) out = out.replace(from, match => { count++; return match[0] === match[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to; });
  return { text: out, count };
}

class Stop extends Error { constructor(message, code) { super(message); this.exitCode = code; } }
let lastRequest = 0, nextId = 1, protocolVersion = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One JSON-RPC message per POST (the server rejects batches). Responses may be JSON or a text/event-stream.
async function rpc(method, params, { notification = false } = {}) {
  const wait = lastRequest + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const id = notification ? undefined : nextId++;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'brainy-prices-mcp-gen-tools/1.0' };
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  let response;
  try {
    response = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Stop(`${method}: timeout after ${TIMEOUT_MS / 1000} s`, 5);
    throw new Stop(`${method}: network error (${error?.cause?.code ?? error?.name ?? 'unknown'})`, 1);
  }
  if (response.status === 429) throw new Stop(`${method}: HTTP 429 rate limited; stopping. Retry-After: ${response.headers.get('retry-after') ?? 'not given'} s`, 4);
  const body = await response.text();
  if (!response.ok) throw new Stop(`${method}: HTTP ${response.status}`, 1);
  if (notification) return null;
  const message = parseMessage(body, response.headers.get('content-type') ?? '', id);
  if (!message) throw new Stop(`${method}: no JSON-RPC response with id ${id}`, 1);
  if (message.error) throw new Stop(`${method}: JSON-RPC error ${message.error.code}: ${String(message.error.message ?? '').slice(0, 200)}`, 2);
  return message.result;
}
function parseMessage(body, contentType, id) {
  const candidates = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) candidates.push(data);
    }
  } else candidates.push(body);
  for (const text of candidates) {
    try { const msg = JSON.parse(text); if (msg && msg.id === id) return msg; } catch { /* not JSON */ }
  }
  return null;
}

async function main() {
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'brainy-prices-mcp-gen-tools', version: '1.0.0' } });
  protocolVersion = init?.protocolVersion ?? PROTOCOL;
  await rpc('notifications/initialized', undefined, { notification: true });
  const tools = [], seen = new Set();
  let cursor, pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new Stop(`tools/list: more than ${MAX_PAGES} pages; nothing written`, 1);
    const result = await rpc('tools/list', cursor ? { cursor } : undefined);
    if (!Array.isArray(result?.tools)) throw new Stop('tools/list: result without a tools array; nothing written', 1);
    tools.push(...result.tools);
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Stop('tools/list: repeated nextCursor; nothing written', 1);
    if (cursor) seen.add(cursor);
  } while (cursor);

  // Only name and description are published here (no titles or annotations).
  const normalized = [];
  const rows = tools.map(tool => {
    const name = String(tool?.name ?? '');
    if (!name) throw new Stop('tools/list: tool without a name; nothing written', 1);
    const d = normalize(tool?.description);
    if (d.count) normalized.push(name);
    return { name, description: d.text.trim() };
  });
  if (new Set(rows.map(r => r.name)).size !== rows.length) throw new Stop('tools/list: duplicate tool names; nothing written', 1);

  const groupOf = name => GROUPS.find(([, match]) => match(name))?.[0] ?? 'Other';
  const sections = [...GROUPS.map(([group]) => group), 'Other'].map(group => [group, rows.filter(r => groupOf(r.name) === group)]).filter(([, list]) => list.length);
  const server = init?.serverInfo ?? {};
  const generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    '# Tools', '',
    '<!-- Generated by scripts/gen-tools.mjs from the live MCP tools/list. Do not edit by hand; run `node scripts/gen-tools.mjs` again. -->', '',
    `${rows.length} read-only tools from \`tools/list\` at \`${ENDPOINT}\` (server ${[server.name, server.version].filter(Boolean).join(' ') || 'unknown'}, MCP protocol ${protocolVersion}), generated ${generated}.`, '',
    'Tool names are the exact identifiers to call. Descriptions are the server text, verbatim except for two wording changes: the label for',
    'household scenarios reads "household" and the label for per-area comparisons reads "area cost comparisons".',
    `${normalized.length ? `Applied in this run to: ${normalized.map(n => `\`${n}\``).join(', ')}.` : 'Not needed in this run.'} Input and output schemas are returned by \`tools/list\`.`, ''
  ];
  for (const [group, list] of sections) {
    lines.push(`## ${group}`, '');
    for (const r of list) lines.push(`### \`${r.name}\``, '', r.description || '(no description)', '');
  }
  const tmp = `${OUT}.tmp-${process.pid}`;
  await writeFile(tmp, `${lines.join('\n').trimEnd()}\n`, 'utf8');
  await rename(tmp, OUT);
  console.log(`TOOLS.md written: ${rows.length} tools in ${pages} page(s); ${sections.map(([g, l]) => `${g} ${l.length}`).join(', ')}; wording changes in ${normalized.length} tool(s).`);
}

main().catch(error => {
  process.stderr.write(`gen-tools: ${error instanceof Stop ? error.message : `unexpected error (${error?.name ?? 'Error'})`}\n`);
  process.exitCode = error instanceof Stop ? error.exitCode : 1;
});
