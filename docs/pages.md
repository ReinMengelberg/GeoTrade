# Pages

How GeoTrade turns a URL into a page: **SvelteKit's file-based router, split into two
route groups — a signed-in shell and a signed-out one — with the auth guard on the group,
not the page.**

This doc covers the URLs that render HTML. For the `/api/*` endpoints see
[routes.md](./routes.md); for what happens to the data once a page has it, see
[stores.md](./stores.md).

## TL;DR

The folder layout under `src/routes` *is* the URL layout — there is no route table to
keep in sync. A folder becomes a path segment, and the special `+` files inside it say
what runs: `+page.svelte` is the page itself, `+layout.svelte` is a frame drawn around
everything below it, and the `+layout.ts` / `+layout.server.ts` files fetch what those
need before anything is drawn.

Two folders have names in parentheses — `(app)` and `(auth)`. Those brackets mean "group
these pages together but don't put this name in the URL". Signed-in pages live in `(app)`
and get the sidebar frame; the login page lives in `(auth)` and gets the split-screen
frame. Because the login check sits on the `(app)` group itself, every page we ever add
in there is protected automatically — nobody has to remember to add the check.

In four steps:

1. The URL picks a folder.
2. That folder's guard runs; if you are not signed in you are sent to `/login`.
3. The load files fetch the page's data, on the server for the first visit.
4. The layout draws the frame, seeds the stores, and the page renders inside it.

## Glossary

- **Router** — the thing that decides which page a URL shows. In SvelteKit it is the
  folder structure, not a config file.
- **Route** — one URL the app can show.
- **Segment** — one slash-separated piece of a URL. `/api/users/3` has three.
- **Route group** — a folder named `(like-this)`. It groups routes so they can share a
  layout or a guard, without adding anything to the URL.
- **Layout** — a component wrapped around every page beneath it: sidebar, header, frame.
- **Nested layouts** — layouts inside layouts; a page is drawn inside all of them.
- **`load` function** — code that runs *before* a page renders and returns its data.
- **Universal load (`+layout.ts` / `+page.ts`)** — a load that runs on the server for the
  first visit and in the browser afterwards. Must not touch secrets or the database.
- **Server load (`+layout.server.ts` / `+page.server.ts`)** — a load that only ever runs
  on the server. Can read `locals`, secrets and the database.
- **`data` prop** — the merged result of all the loads above a component, handed to it.
- **`page.data`** — the same merged data, readable from anywhere via `$app/state`.
- **Guard** — a check that runs before a page and redirects you away if you fail it.
- **Redirect** — an HTTP response telling the browser "go here instead".
- **Hydration** — the browser wiring up server-rendered HTML so it becomes interactive.
- **Client-side navigation** — after the first load, following a link swaps the content
  in place instead of asking the server for a new document.
- **`goto`** — SvelteKit's function for navigating from code rather than from a link.
- **`invalidateAll()`** — "the data is stale, re-run every load function".
- **Context** — Svelte's parent-to-descendant value passing. Only reachable from
  components rendered *inside* the provider.

## The map

```
src/routes/
├── +layout.svelte              root frame — app.css + favicon, nothing visual
│
├── (auth)/                     signed-out group          no URL segment
│   ├── +layout.svelte          split-screen shell
│   └── login/+page.svelte      →  /login
│
├── (app)/                      signed-in group           no URL segment
│   ├── +layout.server.ts       guard: locals.user, else 303 → /login
│   ├── +layout.ts              seed fetch → { user, trades }
│   ├── +layout.svelte          initStores() + sidebar shell
│   └── dashboard/+page.svelte  →  /dashboard
│
└── api/                        endpoints, no UI — see routes.md
```

The parentheses are the whole trick: `(app)/dashboard/+page.svelte` serves `/dashboard`,
not `/app/dashboard`. Groups exist purely so a set of routes can share a layout and a
guard.

## What runs, in order

Two URLs, end to end:

```
/login                                     /dashboard
────────────────────                       ──────────────────────────────────────
                                           (app)/+layout.server.ts   guard + user
                                                    ↓ data
                                           (app)/+layout.ts          + trades
                                                    ↓ data
+layout.svelte            (root)           +layout.svelte            (root)
(auth)/+layout.svelte     shell            (app)/+layout.svelte      initStores + shell
(auth)/login/+page.svelte form             (app)/dashboard/+page.svelte  useStores()
```

The load cascade for `/dashboard`, concretely:

1. **`(app)/+layout.server.ts`** — server only. Reads `locals.user` (put there by
   `src/hooks.server.ts`), redirects to `/login` if absent, otherwise returns `{ user }`.
   Because this is a *server* load it can read `locals`; a universal load cannot.
2. **`(app)/+layout.ts`** — universal. Receives the server load's return as `data`,
   spreads it, and adds the store seed:

   ```ts
   export const load: LayoutLoad = async ({ fetch, data }) => {
     const api = new ApiClient(fetch);
     return { ...data, trades: await api.get<Trade[]>('/api/trades') };
   };
   ```

   The `...data` spread is load-bearing — drop it and `user` never reaches `page.data`,
   which is where `auth.user` reads from.
3. **`(app)/+layout.svelte`** — gets the merged `{ user, trades }` as its `data` prop and
   calls `initStores({ trades: data.trades })` during render.
4. **`(app)/dashboard/+page.svelte`** — calls `useStores()`. It does not touch `data` at
   all; the store owns the trades from here on.

Loads run top-down and their results merge, so anything a layout load returns is visible
to every page under it — both as the `data` prop and as `page.data`.

## Which load file to use

| File | Runs on | Can read `locals` / DB | Use for |
| ---- | ------- | ---------------------- | ------- |
| `+layout.server.ts` / `+page.server.ts` | server only | yes | guards, session, anything secret |
| `+layout.ts` / `+page.ts` | server first, browser after | no | fetching from our own API |

The split in `(app)` is deliberate: the guard *must* be server-only because it reads
`locals.user`, while the seed fetch is universal so that a client-side navigation back to
the page refetches in the browser instead of round-tripping to the server.

> **In a load function, always use the `fetch` the load was given** — `new
> ApiClient(fetch)`, never the `api` singleton. The provided fetch forwards the session
> cookie during SSR and inlines the response for hydration. See stores.md.

## Guards live on the group

`(app)/+layout.server.ts` is eleven lines and protects every route in the group:

```ts
export const load = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return { user: locals.user };
};
```

Adding `(app)/settings/+page.svelte` inherits the guard with no extra work — which is the
reason the groups exist at all. The alternative, a check at the top of every page load,
fails the day someone forgets one.

Two things worth being precise about:

- **This is not the only check.** The guard protects *pages*. Every API endpoint re-checks
  `locals.user` independently, because an endpoint can be called directly with no page
  involved. Never treat a passed guard as authorization for the data behind it.
- **303, not 302.** A redirect after a state-changing request should switch the method to
  GET, which is what 303 means.

## Navigation and session changes

- **Links.** Plain `<a href>` — SvelteKit intercepts them for client-side navigation.
- **From code.** `goto('/dashboard')` from `$app/navigation`, as the login page does after
  a successful sign-in.
- **After a session change.** `invalidateAll()` re-runs every load so `locals.user` is
  re-read and `page.data.user` updates. `auth.signIn` / `signUp` / `signOut` each do this
  before navigating.

Note the ordering in `auth.signOut()`: `invalidateAll()` *then* `goto('/login')`. Reverse
them and you navigate away while the stale user is still in `page.data`.

## Where components read state

Under `(app)`, through the store container:

```svelte
const { trades } = useStores();
```

Under `(auth)`, `useStores()` would return `undefined` — `initStores` is called in
`(app)/+layout.svelte`, and context only reaches components rendered inside the provider.
That is why `login/+page.svelte` imports the `auth` singleton directly:

```svelte
import { auth } from "$lib/stores/auth.svelte";
```

This is correct, not a workaround: `auth` is a stateless module singleton precisely so it
can be used outside the `(app)` tree. Any *stateful* store is reachable only via
`useStores()`, and therefore only from inside `(app)`.

## House rules

- **Guards go on the group's `+layout.server.ts`,** never copy-pasted into pages.
- **Route groups, not URL prefixes,** for anything whose only purpose is sharing a layout
  or a guard.
- **`+layout.server.ts` for anything touching `locals`, secrets or the database;**
  `+layout.ts` for fetching our own API.
- **Universal loads construct `new ApiClient(fetch)`.** The `api` singleton is for store
  methods only.
- **Spread parent `data`** in a universal load that sits above a server load, or you drop
  the parent's keys.
- **Pages read from stores, not from `data`,** once the layout has seeded them — one
  source of truth per slice of state.
- **`invalidateAll()` before `goto`** on anything that changes the session.
- **A passed page guard is not authorization.** Endpoints check for themselves.

## Adding a page

For a signed-in page at `/positions`:

1. `src/routes/(app)/positions/+page.svelte` — the guard, the shell and the stores all
   come for free from the group layout.
2. Reading existing store data? Nothing else to do: `useStores()`.
3. Needs its own data? Prefer a store — add the seed fetch to `(app)/+layout.ts` and the
   store to `initStores`, per stores.md. Add a `+page.ts` only for data genuinely scoped
   to that one page.
4. Route-specific data from the database, never exposed as an endpoint? `+page.server.ts`
   with a load that calls a model directly.
5. Add the link to `src/lib/components/app-sidebar.svelte`.

A signed-out page is the same with `(auth)`, and gets no stores.

## Known drift

- **There is no root `+page.svelte`,** so `/` 404s. Every entry point has to be
  `/login` or `/dashboard` by hand. Add a root page, or a root load that redirects to one
  of them based on `locals.user`.
- **`(auth)/+layout.svelte` re-imports `../../app.css` and re-declares the favicon link**,
  both of which the root `+layout.svelte` already does. Harmless today, but it means the
  root layout is no longer the single place styling is set up. Drop the duplicates.
- **`(app)/+layout.server.ts` uses `throw redirect(...)`,** while the API handlers call
  `error(...)` bare. In SvelteKit 2 these functions throw internally, so the bare call is
  the current idiom — worth matching. The same file is also the only one missing its
  `LayoutServerLoad` type annotation and indented with spaces rather than tabs.
- **No `+error.svelte` anywhere.** Any thrown error renders SvelteKit's default page.

## Alternatives we considered

- **One flat route tree with per-page guards.** No groups to reason about, but the guard
  is then a line every new page must remember; the failure mode is a silently public page.
- **Guarding in `hooks.server.ts` by path prefix.** Catches API routes and pages in one
  place, but reintroduces the path→rule table that file-based routing exists to avoid, and
  it drifts the moment a route moves.
- **`/app` as a real URL prefix instead of a group.** Same layout sharing, uglier URLs,
  and no way to have the login page share the root frame.
