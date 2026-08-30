# Routes and controllers

How GeoTrade serves `/api/*`: **SvelteKit `+server.ts` files are the controllers, and
they stay deliberately thin — fat model, skinny controller.** A handler translates HTTP
into a model call and the result back into a response. Everything else belongs in the
model.

Related: [models.md](./models.md) for the layer these handlers call,
[pages.md](./pages.md) for the URLs that render HTML.

## TL;DR

An endpoint is a file called `+server.ts`. Its folder path is its URL, and it exports one
function per HTTP verb — `GET`, `POST`, `PATCH`, `DELETE`. Those functions are what other
frameworks call *controllers*: we have no separate controllers folder, because the route
file already is one.

A controller here does the same four things every time: check you are signed in, check
you are allowed to touch this particular thing, ask the model to do the work, and turn
the answer into JSON. It never contains rules of its own. If a handler grows past a
handful of lines, that is the signal something belonged in the model instead.

That is the whole of "fat model, skinny controller": **knowledge accumulates in one place
per entity, and the HTTP layer stays a thin translation shell.** The payoff is that the
same rule applies no matter who asks — an endpoint, a page load, a script — because they
all go through the same model.

In four steps:

1. The URL picks a `+server.ts` file, the method picks the exported function.
2. The handler checks the session, then checks permission.
3. It calls a model method and gets plain data back.
4. It returns that data as JSON, or an error with the right status code.

## Glossary

- **Endpoint** — one URL that returns data rather than a page.
- **Handler** — the function that runs for one HTTP method on one endpoint.
- **Controller** — the layer translating an HTTP request into domain work and back. Here,
  the handler.
- **HTTP verb / method** — `GET` read, `POST` create, `PATCH` partial update, `PUT`
  replace, `DELETE` remove.
- **Status code** — the number describing the outcome: 200 ok, 201 created, 204 done-with
  -no-content, 401 not signed in, 403 not allowed, 404 not found, 500 we broke.
- **Authentication** — working out *who* is asking. Done once, in `hooks.server.ts`.
- **Authorization** — working out whether they are *allowed*. Done per request, by the
  model's rule.
- **`locals`** — a per-request bag SvelteKit gives server code, holding the current user.
- **Dynamic segment** — a folder named `[id]`, matching any value and handing it over as
  `params.id`.
- **Rest segment** — a folder named `[...all]`, matching every remaining segment at once.
- **Business logic** — the app's actual rules: what is valid, who may do what, what
  happens as a consequence.
- **Fat model** — those rules live on the model, which is therefore where the code is.
- **Skinny controller** — the handler holds none of them and stays short.
- **Anaemic model** — the opposite failure: models that only hold data while every rule
  lives in handlers, duplicated per route.
- **Domain** — the problem the app is about (users, trades), as opposed to the plumbing.

## The map

```
src/routes/api/
├── auth/[...all]/+server.ts    /api/auth/*     delegated wholesale to Better Auth
├── trades/+server.ts           /api/trades     GET, POST
└── users/[id]/+server.ts       /api/users/:id  GET, PATCH, DELETE
```

Same file-based routing as pages: folders are URL segments, `[id]` captures one segment
into `params.id`, `[...all]` captures the rest.

We keep endpoints under `/api` and pages outside it. SvelteKit does allow a `+server.ts`
and a `+page.svelte` to share a folder — it then routes `GET` by the `accept` header and
sends `PATCH`/`DELETE` to the endpoint — but that split is easy to misread, so we don't
use it.

## The request lifecycle

```
  request
     │
     ▼
 hooks.server.ts        auth.api.getSession()  →  locals.user, locals.session
     │
     ▼
 +server.ts  GET/POST/PATCH/DELETE            ← the controller
     │  1. authenticated?   locals.user           else error(401)
     │  2. authorized?      Model.canAccess()     else error(403)
     │  3. do the work      await Model.x()       ← all rules live here
     │  4. respond          json() / 204          else error(404)
     ▼
  Model  →  Drizzle  →  Postgres
```

Authentication happens once per request, in `src/hooks.server.ts`, for *every* request —
pages and endpoints alike. Authorization happens per handler, because only the handler
knows which row is being touched.

## Anatomy of a controller

`src/routes/api/users/[id]/+server.ts`, in full, is three handlers of four lines each:

```ts
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) error(401, 'Unauthorized');
  if (!User.canAccess(locals.user, params.id)) error(403, 'Forbidden');

  const found = await User.find(params.id);
  if (!found) error(404, 'User not found');

  return json(found);
};
```

Every handler in the codebase follows the same four beats, in the same order:

1. **Authenticate** — `if (!locals.user) error(401, ...)`. Always first, always in every
   handler. A page guard passing does not authorize an endpoint; endpoints are reachable
   directly.
2. **Authorize** — `if (!Model.canAccess(...)) error(403, ...)`. Note the handler does not
   *know* the rule; it asks the model. Today `User.canAccess` is `requester?.id === id`,
   and when a `role` column lands and that becomes "or an admin", every handler inherits
   the change for free.
3. **Delegate** — one `await Model.method(...)` call.
4. **Respond** — `json(row)`, or `error(404)` when the model returned `null`.

401 before 403 matters: "not signed in" and "signed in but not allowed" are different
answers, and collapsing them into one leaks or hides information depending which you pick.

## Fat model, skinny controller

The rule of thumb: **a controller may know about HTTP, and a model may know about the
domain, and neither should know about the other.**

### The split

| Belongs in the controller | Belongs in the model |
| ------------------------- | -------------------- |
| Reading `params`, query string, headers | What a valid trade is |
| Parsing the request body | Who may see or change a row |
| Checking the *shape* of input (is `quantity` a number?) | Checking *invariants* (is the account funded enough?) |
| Choosing a status code | What happens as a consequence of a write |
| Serialising to JSON | Which columns are writable (`fillable`) |
| Turning `null` into a 404 | Returning `null` when nothing matched |

The two validation rows are the subtle ones. *Shape* validation is HTTP work — the body
arrived from outside and might not even be an object. *Invariant* validation is domain
work — it must hold no matter how the write arrived.

### Why it is worth the discipline

- **One rule, one place.** `canAccess` is asked by three handlers today. Written inline,
  it would be three copies drifting apart, and the fourth handler would forget it.
- **Callers other than HTTP.** A `+page.server.ts` load, a seed script, a future cron job
  and a test all call the model directly. Logic living in a handler is reachable only by
  making an HTTP request to yourself.
- **Testable without a server.** `User.canAccess(u, id)` is a pure function call. The same
  rule embedded in a handler needs a request, a session and a running app to exercise.
- **Handlers become skimmable.** When every handler is the same four beats, a reviewer
  reads the shape rather than the details, and an *unusual* handler stands out as
  something to look at.

"Fat" is not an aspiration — nobody wants a bloated model. It names where the weight
*should* settle when there is weight to place.

### The counter-example, in our own codebase

`src/routes/api/trades/+server.ts` is what a fat controller looks like:

```ts
let nextId = 3;
const trades: Trade[] = [ /* ... */ ];

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, 'Unauthorized');

  const input: NewTrade = await request.json();
  const trade: Trade = { id: nextId++, ...input };
  trades.push(trade);

  return json(trade, { status: 201 });
};
```

It is honest placeholder code — there is no `trade` table yet — but it shows every
symptom:

- **Storage lives in the handler.** The data is module state in a route file.
- **Identity generation lives in the handler.** `nextId++` is a rule about trades.
- **No ownership rule at all.** There is no `canAccess`, and no `userId` on a trade, so
  every signed-in user sees and edits the same list.
- **It leaks across requests.** Module-level state on the server is shared by all
  visitors — the exact hazard stores.md describes, here on the server side.
- **Nothing else can reuse it.** A page load that wanted trades would have to make an HTTP
  call to this route.

The fix is the "adding a new model" recipe in models.md, after which the handler is:

```ts
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, 'Unauthorized');

  const created = await Trade.createFor(locals.user, await request.json());

  return json(created, { status: 201 });
};
```

The id now comes from the table default, ownership from `createFor`, and over-posting is
stopped by `fillable`. The handler kept only the HTTP.

### Signs a controller is getting fat

- An `if` about domain data rather than about the request.
- A second `await` on the database in one handler — that is a transaction, and it belongs
  in a model method using `builder`.
- Any arithmetic, formatting, or defaulting of domain values.
- Copy-pasting a block between two handlers.
- Importing `db` or a Drizzle operator into a route file. Routes import models.

### Fat model is not god object

The counterweight: when logic spans several entities, or belongs to no entity in
particular, it is not model logic either. That is what `src/lib/services/` is for —
stateless modules that orchestrate models. A model owns *its table's* rules; a service
owns a workflow. Neither is the controller's job.

### Loads are controllers too

`+page.server.ts` load functions and form actions occupy exactly the same position in the
stack as `+server.ts` handlers: they take a request, call the domain, and shape a
response. Everything above applies to them unchanged — a load with business logic in it is
a fat controller wearing a different filename.

## Responses

| Situation | Return |
| --------- | ------ |
| Read or update succeeded | `json(row)` — 200 |
| Created | `json(row, { status: 201 })` |
| Deleted, nothing to send back | `new Response(null, { status: 204 })` |
| Not signed in | `error(401, 'Unauthorized')` |
| Signed in, not permitted | `error(403, 'Forbidden')` |
| No such row | `error(404, '<Thing> not found')` |

Models return `null` / `false` rather than throwing, so mapping "nothing matched" to a
404 is the handler's decision — which is right, since only the handler knows the caller
speaks HTTP.

### The contract with the client

The client half of this lives in `src/lib/services/api.ts`, and two details have to stay
in step:

- **204 has no body.** `ApiClient.request` special-cases `res.status === 204` and skips
  `res.json()`. A handler returning 204 *with* a body, or 200 with an empty one, breaks
  the client.
- **Errors carry `message`.** SvelteKit's `error(401, 'Unauthorized')` serialises to
  `{ message: 'Unauthorized' }`, and `ApiClient` reads `data.message` to build its
  `ApiError`. Keep error text meaningful — it can surface in the UI.

## The Better Auth catch-all

```ts
export const GET = toSvelteKitHandler(auth);
export const POST = toSvelteKitHandler(auth);
```

`api/auth/[...all]/+server.ts` hands every `/api/auth/*` URL to Better Auth. Sign-up,
sign-in, sign-out and session endpoints are all defined by the library — do not add
handwritten routes alongside them, and do not write to the auth tables through models
(see "Who owns writes" in models.md).

## House rules

- **Every handler checks `locals.user` first.** No exceptions, no inherited trust from a
  page guard.
- **Authorization is a model method,** called by the handler, never inlined into it.
- **One model call per handler** where possible. Two suggests a missing model method.
- **Routes never import `db`** or Drizzle operators.
- **Return the row from writes.** All model writes use `.returning()`, so the client
  updates from the response instead of refetching — that is what the store mutations rely
  on.
- **`error()` and `redirect()` are called bare,** not thrown; they throw internally in
  SvelteKit 2.
- **Type handlers with `RequestHandler` from `./$types`,** which types `params` from the
  folder name.
- **Don't invent status codes.** The table above covers everything we do today.

## Adding an endpoint

For `/api/trades/[id]`:

1. Make sure the model exists and owns the rules — including a `canAccess` that compares
   the requester against the row's `userId`. Do this first; the handler is the easy part.
2. `src/routes/api/trades/[id]/+server.ts`, exporting the verbs you need.
3. Write each handler as the four beats: authenticate, authorize, delegate, respond.
4. If a handler needs anything more than that, stop and move it into the model.
5. Add a method to `ApiClient` only if the verb is missing; otherwise call the existing
   `get` / `post` / `patch` / `delete` from a store method.

## Known gaps

- **No request-body validation.** `PATCH /api/users/[id]` passes `await request.json()`
  straight into `User.update`. `fillable` stops over-posting — an extra key is dropped —
  but nothing checks *types*, so `{ name: 12345 }` reaches Postgres and surfaces as a 500
  rather than a 400. Shape validation is controller work; a schema validator at the top of
  each write handler is the missing piece.
- **`/api/trades` is unowned and in-memory,** as described above. It is the one endpoint
  that does not follow this doc.
- **No rate limiting** on any endpoint, including the auth catch-all.

## Alternatives we considered

- **A real `controllers/` directory,** with route files as one-line delegations. Standard
  in Express-style apps, but SvelteKit already gives one file per route with typed params;
  a second layer would be indirection with nothing in it as long as handlers stay skinny.
- **Business logic in the handlers, models as plain table wrappers** (the anaemic-model
  route). Fewer files and a shorter path for the first endpoint, at the cost of
  duplicating every rule per route — which is exactly what `canAccess` and `fillable`
  exist to prevent.
- **Form actions instead of JSON endpoints.** More idiomatic SvelteKit and works without
  JS, but the client is store-driven and mutates from the API response; actions would push
  us back to `invalidateAll()` round-trips. See the trade-off discussion in stores.md.
