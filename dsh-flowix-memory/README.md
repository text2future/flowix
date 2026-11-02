# dsh-flowix-memory

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle  
that registers the **local** `flowix-cli` **MCP server** with any Harness instance. Once installed, the agent gets the  
`mcp__flowix__memo` tool to search, read, create, and edit  
Flowix Markdown memos, and to create declared plugin artifacts such as mind maps.

The bundle includes a small launcher. It transparently proxies to `flowix-cli`  
when installed; otherwise it keeps the tool registered and returns an  
actionable installation error to the agent. The launcher is a `cordis.patch.yml`  
that inserts one  
`@deepseek-ai/dsh-mcp-client`  
row, which ships inside every Harness distribution. Nothing here connects to a  
remote Flowix service — the CLI is spawned locally over stdio and reads the  
local notebook data directory.

## Prerequisites

1. A `flowix` command on `PATH` (or set `FLOWIX_CLI_PATH` to the absolute  
 `flowix-cli` binary path) is needed to use the memo operations. If it is  
 missing, the tool explains how to install Flowix from  
 `https://flowix-memo.com/latest.json`. The CLI is built from the  
 [flowix-main](https://github.com/text2future/flowix) repository  
 (`app/flowix-cli`, binary `flowix-cli`).
2. Access to the Flowix notebook data the CLI should manage. Defaults to the  
 user config directory (`~/.flowix`); override with `FLOWIX_HOME` /  
 `FLOWIX_DATA` when the data lives elsewhere.

## Install

`dsh plugin` manages one profile at a time and requires `--profile <name>`.  
Flowix uses the `flowix` profile. In other DSH clients, `flowix` is simply a  
custom profile name and can be created by the same command. The bundle remains independent from  
Flowix's host/control bridge and ships in the  
[flowix-main](https://github.com/text2future/flowix) repository and is not yet  
published to npm, so install it from the checkout:

```sh
# from the flowix-main checkout root
dsh plugin --profile flowix add ./dsh-flowix-memory
```

Once published, the npm package installs the same way:

```sh
dsh plugin --profile flowix add dsh-flowix-memory
```

The row activates for that profile. Other DSH clients can start it with  
`dsh --profile flowix`; this profile also ships `dsh-appserver` so the  
Flowix App Server JSON-RPC surface is available out of the box.

## Verify

Start Harness with the profile you installed into (`dsh --profile flowix`),  
then check that the tool is registered:

```
mcp__flowix__memo
```

Prefer structured arguments:

```json
{"action":"search","query":"product plan","notebook":"work","tag":"project/flowix","limit":20}
```

To read a collection, call `collection.list`, use its `collectionId` with
`collection.describe`, then call `collection.query`. Hybrid collections need
`domain: "notes"`, `"media"`, or `"work_documents"`. Query results for notes
include an `address`; pass it to `{"action":"show","address":"..."}` to read
the Markdown body. Pass the returned `snapshot` and `nextOffset` to each next
page. Use `collection.read` when you need the raw YAML payload.

```json
{"action":"collection.list","notebook":"work","limit":50,"offset":0}
{"action":"collection.describe","notebook":"work","collectionId":"col_…"}
{"action":"collection.query","notebook":"work","collectionId":"col_…","domain":"notes","limit":50,"offset":0}
```

The legacy `{ "command": "search ...", "stdin": "..." }` form remains  
accepted for compatibility but is no longer the recommended contract.

## Configuration


| Key               | Default                | Meaning                                    |
| ----------------- | ---------------------- | ------------------------------------------ |
| `FLOWIX_CLI_PATH` | `flowix` (PATH lookup) | Absolute path to the flowix-cli executable |


If the CLI is unavailable, calling the tool returns an installation message  
with `https://flowix-memo.com/latest.json`. Install Flowix, then restart the  
profile so the launcher reconnects to `flowix-cli mcp`.

## Uninstall

```sh
dsh plugin --profile flowix remove dsh-flowix-memory
```

## Notes

- The MCP stdio bridge strips ambient credential-like variables and all  
`DSH_*` variables before spawning the child; other ambient variables  
(including `HOME`/`PATH`) are inherited.
- Flowix Desktop installs this same bundle into its `flowix` profile and sets  
`FLOWIX_DSH_MCP_CLI`. Other DSH clients can install it into any profile and  
use `FLOWIX_CLI_PATH` or the `flowix` executable on PATH. There is one  
canonical bundle patch and no embedded duplicate row.
