# Brainy Prices

[![Glama connector score](https://glama.ai/mcp/connectors/ae.brainy/grocery-prices/badges/score.svg)](https://glama.ai/mcp/connectors/ae.brainy/grocery-prices)

**Brainy Prices — UAE cost-of-living data as a remote MCP server and REST API.**

Query groceries, historical school tuition, registered property medians, transport, utilities and relocation estimates from the same admitted sources as the website. Every result includes source, date, availability and licence conditions. Anonymous access requires no account or API key.

This repository contains connection documentation and executable client examples for the hosted service.

## Endpoints

| Interface | Address |
| --- | --- |
| MCP v2, Streamable HTTP | https://prices.brainy.ae/mcp/v2 |
| REST v2 | https://prices.brainy.ae/api/v2 |
| OpenAPI | https://prices.brainy.ae/api/v2/openapi.json |
| API catalogue, Linkset discovery | https://prices.brainy.ae/.well-known/api-catalog |
| MCP Registry | [ae.brainy/grocery-prices, version 2.0.0](https://registry.modelcontextprotocol.io/v0.1/servers/ae.brainy%2Fgrocery-prices/versions/2.0.0) |

MCP accepts **2025-11-25**, **2025-06-18** and **2025-03-26**. Service version **2.0.0** is separate from the MCP protocol version. No authentication headers are needed. MCP uses stateless JSON responses: POST only; no session identifier is issued. Send `Accept: application/json, text/event-stream` and `Content-Type: application/json`. After initialization, send the negotiated `MCP-Protocol-Version` header and acknowledge with `notifications/initialized`.

## Tools

[TOOLS.md](TOOLS.md) is generated from production `tools/list` by [scripts/gen-tools.mjs](scripts/gen-tools.mjs). The current catalogue has 24 tools across groceries; schools; housing and household costs; transport and utilities; health and relocation; and highlights and sources. Tool input/output schemas are available through `tools/list`.

Regenerate with Node.js 20 or later:

```sh
node scripts/gen-tools.mjs
```

The script contacts the hosted endpoint, spaces requests by at least 1.1 seconds and writes metadata only. It groups tool names and descriptions and uses neutral display labels for two source description phrases. It does not change the service's schemas or identifiers.

## Connect a client

### Claude Desktop

Where available, add a custom remote connector with `https://prices.brainy.ae/mcp/v2`. Availability depends on your plan and administrator settings; see [Claude's remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For Desktop clients using the local `mcpServers` configuration, a stdio bridge is an alternative. Install Node.js and use this configuration in `claude_desktop_config.json`, then restart Desktop:

```json
{
  "mcpServers": {
    "brainy-prices": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://prices.brainy.ae/mcp/v2", "--transport", "http-only"]
    }
  }
}
```

This alternative installs the external `mcp-remote` bridge; the examples in this repository do not require it. See the [bridge documentation](https://github.com/punkpeye/mcp-remote).

### Claude Code

```sh
claude mcp add --transport http brainy-prices https://prices.brainy.ae/mcp/v2
claude mcp list
```

See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp).

### Cursor

Add to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "brainy-prices": { "url": "https://prices.brainy.ae/mcp/v2" }
  }
}
```

See [Cursor's MCP guide](https://cursor.com/docs/mcp).

### VS Code

Add to your project's `.vscode/mcp.json`, then start the server using the editor's MCP controls:

```json
{
  "servers": {
    "brainy-prices": {
      "type": "http",
      "url": "https://prices.brainy.ae/mcp/v2"
    }
  }
}
```

See [VS Code's MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

### Generic MCP client

Select a remote **Streamable HTTP** server, use `https://prices.brainy.ae/mcp/v2`, and choose **no authentication**. The client must support one of the protocol versions above. Initialize, acknowledge initialization, discover tools, and supply arguments that match the returned schema.

## Executable examples

Run sequentially from this repository's root:

```sh
bash examples/curl.sh
node examples/node.mjs
python3 examples/python.py
```

Requirements: curl, Bash, Python 3 and the usual shell text utilities for `curl.sh`; Node.js 20+ for `node.mjs` (native `fetch`); Python 3.9+ for `python.py` (standard-library `urllib`). No third-party libraries are needed.

Each example initializes MCP, acknowledges initialization, lists tools, calls `fuel_prices` with empty arguments, and queries REST `/api/v2/transport/fuel-prices`. They print a short response summary and space requests by at least 1.1 seconds. They stop on errors, including quota responses. Inspect `Retry-After` before trying again; avoid running examples concurrently.

## Limits and selective queries

Anonymous v2 access allows **30 requests per minute and 500 per UTC day**, per verified network identity (IPv6 /64). REST v2 requests and MCP v2 tool calls share this quota. Discovery and initialization have a separate request-rate control. HTTP 304, validation errors and paused results still consume the data quota; HTTP 429 carries `Retry-After`.

Where pagination is supported, `page_size` is at most **50**. Reuse the actual `meta.page.next_cursor` while keeping the original query. Product, school and other selective routes may require filters: `filter_required` means supply an admitted search or selection filter. An invalid cursor yields 400; an expired cursor or changed snapshot yields 409, requiring a fresh selective query. Do not enumerate the entire inventory.

Read response metadata and preserve availability, pause reasons, source notices and missing values. A paused source remains empty until its source review permits use. Unknown amounts and dates stay unknown. Cache privately and retain attribution; revalidate with ETag when supported.

## Sources, attribution and dataset terms

When displaying a result, cite **the original source and its date or reference period**, plus “Source: Brainy Prices, prices.brainy.ae, <date>” and the browser link. Retain source-specific attribution, notices, exclusions and licence conditions. There is no blanket licence over all responses. Resolve each row's `source_id` and `license_id` in `meta.dataset.sources` and preserve browser links.

| Dataset or component | Source and conditions |
| --- | --- |
| Historical school tuition; tuition inputs in household estimates | **KHDA: unaltered, not for profit.** Tuition data is for non-commercial use and must not be altered. Keep the original published Year/Grade labels and academic year; do not sell, monetise or modify the data. |
| Registered property aggregates; property inputs in household and relocation estimates | **Dubai Land Department: Dubai Open Data Licence.** Retain the DLD originator attribution, copyright notice, original links and reference period. Contractual medians are not listings. Adapted material stays under that licence; the service does not imply government endorsement. |
| School locations/distances and route components | **OpenStreetMap: ODbL.** Credit © OpenStreetMap contributors. Locations are approximate; school distances are straight-line distances. Preserve the applicable ODbL conditions. |
| Grocery observations and reference prices, buyer reports, transport, utilities, telecom, health, residence, company fees and FX | Each source keeps its own permissions and conditions, supplied in the response. **No terms confirmed: per-query display with attribution and a link only; no licence is implied; no bulk redistribution.** This condition applies to components whose source terms are marked unconfirmed. Paused components remain empty. |
| Household, commute, area and relocation calculations and dated highlights | Every input source keeps its own terms, listed in the response. A derived figure does not grant broader rights over its inputs. |

The API serves selective queries. No bulk access or open dataset is offered. Source metadata and anonymous access do not grant an export or redistribution licence. Public accessibility is not permission to collect or redistribute a source.

## Data notice and contact

Data changes. Each response includes source and date information, with unknown values kept explicit. UAE cost amounts are in **AED**; preserve any explicitly labelled source-currency amounts in FX or relocation results. Historical periods, assumptions and incomplete coverage remain explicit.

[Developer documentation](https://prices.brainy.ae/developers.html) · [Source conditions](https://prices.brainy.ae/api/v2/sources) · [Privacy](https://prices.brainy.ae/privacy.html)

Operated by **SOFT DEV FZ LLC**. Contact: **prices@brainy.ae**.

## Repository licence

MIT applies to the examples and docs in this repository only; data returned by the service keeps each source's terms. See [LICENSE](LICENSE).
