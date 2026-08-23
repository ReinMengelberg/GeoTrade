# Stores

How GeoTrade manages frontend state: a **context-seeded store pattern**, modeled on how
Pinia does SSR in Vue. Server-rendered first paint, then SPA-style stores that own the
data — without the cross-request leaks SvelteKit warns about.

## The problem this solves

Two facts about SvelteKit shape everything here:

1. **SSR renders components once, synchronously.** Only `load` functions are awaited on
   the server; `$effect`/`onMount` never run there. So a store that fetches its own data
   can't get that data into the server-rendered HTML.
2. **Module-level state is shared across requests on the server.** A module singleton
   like `let user = $state(...)` written during SSR leaks one user's data into another
   user's HTML.

So we want stores that own the data (SPA ergonomics), but the *initial* data must come
through a `load` function, and the store holding it must be *per-request* on the server.
That's exactly what this pattern does.

## The flow

```
                         server, per request                    browser
┌──────────────────┐   ┌─────────────────────┐   ┌──────────────────────────────────┐
│ hooks.server.ts  │ → │ (app)/+layout.ts    │ → │ (app)/+layout.svelte             │
│ session → locals │   │ seed fetch via      │   │ initStores(seed) → context       │
│ guard in         │   │ ApiClient(fetch)    │   │                                  │
│ +layout.server.ts│   │                     │   │ components: useStores()          │
└──────────────────┘   └─────────────────────┘   │ mutations: store methods → api   │
                                                 └──────────────────────────────────┘
```

1. `src/routes/(app)/+layout.server.ts` — auth guard; returns `user`.
2. `src/routes/(app)/+layout.ts` — fetches seed data (e.g. `/api/trades`) with
   `new ApiClient(fetch)` and returns `{ ...data, trades }`.
3. `src/routes/(app)/+layout.svelte` — calls `initStores({ trades: data.trades })`
   **during render**. Every SSR request builds fresh store instances, so seeding here
   can never leak between users. In the browser the same call runs once at boot and the
   instances live for the whole session.
4. Components call `useStores()` and read/mutate through the store:

```svelte
<script lang="ts">
  import { useStores } from "$lib/stores";

  const { trades } = useStores();
</script>

{#each trades.trades as trade (trade.id)}...{/each}
```

Because the seed happens during render, the trades are in the SSR HTML — no skeleton
flash — and hydration replays the load's inlined fetch response instead of refetching.

## The pieces

### `src/lib/services/api.ts` — one ApiClient, two constructions

`ApiClient` is a class wrapping an injected `fetch`, because there are two correct
fetches:

- **In load functions:** `new ApiClient(fetch)` with the load-provided fetch. On the
  server that fetch forwards the session cookie and inlines the response for hydration.
  This is the only place the client is constructed by hand.
- **Everywhere else:** the exported `api` singleton (browser `fetch`). Store methods only
  run from user events in the browser, so this is always correct there. The singleton is
  safe at module level because it holds no request state.

> **Never use the `api` singleton inside a `load` function.** It works in dev during
> client-side navigation, then 401s only on SSR page loads (no cookie forwarded).

### `src/lib/stores/index.ts` — the container

`initStores(seed)` builds all store instances and puts them in Svelte context under one
key; `useStores()` retrieves them. Context (rather than module singletons) is what makes
the stores per-request on the server. The container also exposes `auth` so components
have a single entry point for state.

Consequence of using context: stores are reachable from components under the `(app)`
layout only — not from arbitrary `.ts` modules. Services stay stateless for this reason.

### Store classes — e.g. `src/lib/stores/trades.svelte.ts`

A store is a plain class in a `.svelte.ts` file: `$state` fields, a constructor taking
the seed, async methods for mutations and refresh. Mutations update state optimistically
from the API response (`this.trades.push(created)`) — no `invalidate()` round-trips.

### The exception: `src/lib/stores/auth.svelte.ts`

`auth` is a module singleton, allowed because it stores nothing: `auth.user` is a getter
reading through to `page.data.user` (per-request safe via `$app/state`), and its methods
(`signIn`, `signUp`, `signOut`) wrap the Better Auth client. Session data stays owned by
the server pipeline: hooks → `locals` → `+layout.server.ts` → `page.data`.

## House rules

- **Seed-once.** `initStores` runs once per app boot. If the layout load re-runs (e.g.
  `invalidateAll()` after sign-in), stores are *not* re-seeded — freshness after boot
  goes through store methods like `refresh()`. This is a deliberate "store wins" answer
  to the dual-source-of-truth problem; don't add `$effect` re-sync without revisiting it.
- **Module `$state` may only be written from browser code paths** (event handlers,
  `onMount`, `$effect`). Never during render or in a load.
- **Loads construct their own `ApiClient(fetch)`;** stores import the `api` singleton.
- **Per-user data never lives in module scope.** Stateless singletons (services, `auth`'s
  methods) are fine.

## Adding a new store

1. Add the type to `src/lib/types.ts`.
2. Create the endpoint under `src/routes/api/<thing>/+server.ts` (check `locals.user`).
3. Write the store class in `src/lib/stores/<thing>.svelte.ts` — seed in constructor,
   mutations as methods using `api`.
4. Register it: one line in `initStores` (and `SeedData`/`Stores` in
   `src/lib/stores/index.ts`), one line fetching the seed in
   `src/routes/(app)/+layout.ts`.
5. Consume via `useStores()` in components.

## Alternatives we considered

- **Store-owned CSR** (`ssr = false`, stores fetch everything client-side): simplest,
  but no SSR paint. We ran this briefly before switching.
- **Load-owned data with lens stores** (stores as getters over `page.data`, freshness
  via `invalidate()`): most SvelteKit-idiomatic, but data ownership stays with loads and
  every mutation needs invalidation plumbing.
- **Seeding after render** (`$effect` into a singleton): SSR-safe without context, but
  the server HTML ships empty — you pay for SSR and still get a skeleton flash.

The context-seeded pattern costs the most machinery but is the only one giving both SSR
HTML and store ownership. Svelte's experimental async SSR + remote functions may
eventually make this simpler; revisit when those stabilize.
