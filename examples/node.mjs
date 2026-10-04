#!/usr/bin/env node
// Brainy Prices: MCP v2 + REST v2 walkthrough with native fetch (Node.js 18+, no dependencies).
//   node examples/node.mjs
// Steps: initialize → notifications/initialized → tools/list (follows nextCursor) → tools/call fuel_prices → GET /api/v2/transport/fuel-prices.
// Prints a short summary of each answer (three fuel prices, dates and source), never raw JSON or data rows. Requests are at least 1.1 s apart (anonymous limit: 30/min, 500/day,
// shared by REST and MCP); an HTTP 429 stops the script.
// Exit codes: 0 ok, 1 HTTP/network error, 2 JSON-RPC error, 3 tool returned isError, 4 rate limited (429), 5 timeout.
const BASE = 'https://prices.brainy.ae';
const MCP_URL = `${BASE}/mcp/v2`, REST_URL = `${BASE}/api/v2/transport/fuel-prices`;
const PROTOCOL = '2025-11-25', SPACING_MS = 1100, TIMEOUT_MS = 20000, MAX_PAGES = 20;

class Stop extends Error { constructor(message, code) { super(message); this.exitCode = code; } }
let lastRequest = 0, nextId = 1, protocolVersion = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(label, url, init) {
  const wait = lastRequest + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  let response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (error) {
    if (error?.name === 'TimeoutError') throw new Stop(`${label}: timeout after ${TIMEOUT_MS / 1000} s`, 5);
    throw new Stop(`${label}: network error (${error?.cause?.code ?? error?.name ?? 'unknown'})`, 1);
  }
  if (response.status === 429) throw new Stop(`${label}: HTTP 429 rate limited; stopping. Retry-After: ${response.headers.get('retry-after') ?? 'not given'} s`, 4);
  const body = await response.text();
  if (!response.ok) {
    // REST errors are RFC 9457 problem documents with a static code/title; print only those.
    let problem = ''; try { const p = JSON.parse(body); problem = p.code ? ` ${p.code}: ${p.title ?? ''}` : ''; } catch { /* not JSON */ }
    throw new Stop(`${label}: HTTP ${response.status}${problem}`, 1);
  }
  return { response, body };
}

// One JSON-RPC message per POST. The answer may be plain JSON or a text/event-stream with data: lines.
async function rpc(method, params, { notification = false } = {}) {
  const id = notification ? undefined : nextId++;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  const { response, body } = await request(method, MCP_URL, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }) });
  if (notification) return { status: response.status };
  const texts = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).map(e => e.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')).filter(Boolean)
    : [body];
  let message = null;
  for (const text of texts) { try { const m = JSON.parse(text); if (m?.id === id) message = m; } catch { /* skip */ } }
  if (!message) throw new Stop(`${method}: no JSON-RPC response with id ${id}`, 1);
  if (message.error) throw new Stop(`${method}: JSON-RPC error ${message.error.code}: ${String(message.error.message ?? '').slice(0, 200)}`, 2);
  return message.result;
}

// Dates and source exactly as the envelope states them; only the fields that are present.
function provenance(meta) {
  const d = meta?.dataset ?? {};
  const dates = [['period', d.reference_period?.label], ['published', d.published_on ?? d.published_at], ['observed', d.observed_on ?? d.observed_at], ['compiled', d.compiled_at]]
    .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
  return `${dates || 'no date fields in this response'}; ${String(meta?.attribution ?? 'no attribution').slice(0, 240)}`;
}
const threePrices = prices => Object.entries(prices ?? {}).slice(0, 3).map(([grade, aed]) => `${grade} ${aed ?? 'unknown'}`).join(', ') || 'no prices published';

async function main() {
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'brainy-prices-example-node', version: '1.0.0' } });
  protocolVersion = init?.protocolVersion ?? PROTOCOL;
  console.log(`initialize: ${init?.serverInfo?.name ?? 'server'} ${init?.serverInfo?.version ?? ''}, MCP protocol ${protocolVersion}`);

  const ack = await rpc('notifications/initialized', undefined, { notification: true });
  console.log(`notifications/initialized: HTTP ${ack.status}`);

  const names = [], seen = new Set();
  let cursor, pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new Stop(`tools/list: more than ${MAX_PAGES} pages`, 1);
    const result = await rpc('tools/list', cursor ? { cursor } : undefined);
    names.push(...(result?.tools ?? []).map(t => t.name));
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Stop('tools/list: repeated nextCursor (incomplete list)', 1);
    if (cursor) seen.add(cursor);
  } while (cursor);
  console.log(`tools/list: ${names.length} tools in ${pages} page(s), e.g. ${names.slice(0, 5).join(', ')}`);

  const call = await rpc('tools/call', { name: 'fuel_prices', arguments: {} });
  const text = (call?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (call?.isError) throw new Stop(`tools/call fuel_prices: tool error: ${text.split('\n')[0].slice(0, 200)}`, 3);
  const dataset = call?.structuredContent?.meta?.dataset ?? {};
  console.log(`tools/call fuel_prices: status ${dataset.status ?? 'unknown'}, month ${call?.structuredContent?.data?.month ?? 'n/a'}`);
  console.log(`  ${text.split('\n')[0].slice(0, 240)}`);
  console.log(`  ${provenance(call?.structuredContent?.meta)}`);

  const { response, body } = await request('GET /api/v2/transport/fuel-prices', REST_URL, { headers: { Accept: 'application/json' } });
  const rest = JSON.parse(body);
  console.log(`REST fuel-prices: HTTP ${response.status}, status ${rest?.meta?.dataset?.status ?? 'unknown'}, month ${rest?.data?.month ?? 'n/a'}, ${rest?.data?.unit ?? ''}`);
  console.log(`  ${threePrices(rest?.data?.prices)}`);
  console.log(`  ${provenance(rest?.meta)}`);
  console.log(`  RateLimit: ${response.headers.get('ratelimit') ?? 'n/a'}`);
}

main().catch(error => {
  console.error(error instanceof Stop ? error.message : `unexpected error (${error?.name ?? 'Error'})`);
  process.exitCode = error instanceof Stop ? error.exitCode : 1;
});
