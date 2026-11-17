# Amber Forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w6-rev2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w6-rev2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub core clone built from scratch as a single dependency-free Node.js
service: the REST API (`/api/v3`), the git smart-HTTP protocol (v0 and v2,
with shallow/deepen fetch math), a GraphQL endpoint with cursor
connections and mutations, and an MCP tool surface — all projecting one
in-memory universe of repositories, so an object created through any
surface is the same object through all of them.

## Running

```sh
npm start
```

The process expects `MAKEFUN_ENV_URL` (where it registers its ephemeral
port and polls for the end of the trial) and `MAKEFUN_SHOP_TOKEN` (the
Bearer credential every surface checks). Node.js ≥ 22.18, no packages to
install: the runtime is the standard library only, TypeScript executed
directly via type stripping.

## Layout

- `main.ts` — the trial lifecycle: bind, register, serve, exit on done.
- `app.ts` — HTTP plumbing, the auth gate, and routing to the surfaces.
- `rest.ts` — `/api/v3`: repositories, contents, refs, branches, commits,
  labels, issues, comments, pull requests and merges.
- `githttp.ts` — smart HTTP: advertisement, `ls-refs`, fetch with exact
  want/have set math and shallow bookkeeping, receive-pack with
  report-status.
- `graphql.ts` — a hand-written lexer, parser and executor for the forge
  schema, with opaque global ids and introspection.
- `mcp.ts` — JSON-RPC tools over the same records (handshake-era MCP).
- `forge.ts` — repository state and the domain operations every surface
  shares.
- `store.ts` — the content-addressed object database: pack read/write,
  reachability, ancestry, three-way tree merges and diffs.
- `scenario.ts` — the deterministic cast derivation (who the viewer is).

## Performance notes

The hot paths are built to stay flat: each pack object is inflated exactly
once (the inflater reports the consumed byte count, which is where the next
object starts), each object is hashed exactly once, ancestry checks are
depth-first with early exit and memoisation, and built fetch packs are
cached per repository against the exact request key, so repeated identical
fetches cost one build. Nothing heavy runs at module load; caches warm on
first use and stay warm.
