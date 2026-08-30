# Models

How GeoTrade talks to Postgres: **Drizzle owns the schema and the types, a thin
Eloquent-style `Model` base class owns the common queries.** Rows stay plain objects —
this is deliberately not Active Record.

Frontend state is a separate concern; see [stores.md](./stores.md). Models never cross
the server boundary — `$lib/server/**` is compile-time enforced by SvelteKit.

## TL;DR

The database has tables. Each table is described once in TypeScript — the columns, their
types, which ones can be empty. That description is the single source of truth: we change
it and push it to the database, never the other way round.

For each table there is also a *model*: one object that knows how to fetch, create,
update and delete rows of that table, plus anything specific to it ("find a user by
email", "may this person see this row?"). Routes never write queries themselves; they ask
the model. The model also keeps a short list of the fields an outside request is allowed
to set, so someone can't sneak an extra field into a form submission and change something
they shouldn't.

Rows come back as plain objects, not as special "model" objects — the model is the thing
you call methods on, the row is just data.

In four steps:

1. A table is described in a schema file.
2. TypeScript reads that description and works out the exact shape of a row.
3. A model declares which table it belongs to and which fields are writable from outside.
4. API routes check who is asking, then call the model and return the rows as JSON.

## Words used in this doc

- **Schema** — the description of a table's columns, written in TypeScript.
- **Table / row / column** — a table is one kind of thing (users, trades); a row is one
  of them; a column is one field on it.
- **Primary key** — the column that uniquely identifies a row. Here always a `uuid`.
- **Foreign key** — a column pointing at another table's row, e.g. a trade's owner.
- **Cascade delete** — when a row is deleted, rows pointing at it go too.
- **Migration** — changing the real database so it matches the schema files.
- **ORM** — a library that turns database rows into objects for you.
- **Query builder** — a library that helps you write SQL safely, but stops there. Drizzle
  is this, not an ORM — which is why we add a small model layer on top.
- **Active Record** — the ORM style where a row *is* an object with its own `.save()`.
  We deliberately do not do this.
- **Model** — one object per table holding its queries and its rules.
- **CRUD** — create, read, update, delete: the four basic operations.
- **Mass assignment** — handing a whole request body to an update in one go.
- **Over-posting** — the attack that makes mass assignment dangerous: adding a field to
  the request that the form never showed, hoping it gets written anyway.
- **`fillable`** — the allowlist of fields an outside request may set. Everything else in
  the body is dropped.
- **Type inference** — TypeScript working out a type on its own, here the row shape from
  the schema.
- **Singleton** — one shared instance of something, used everywhere in the app.
- **Barrel file** — an `index.ts` that re-exports a folder's contents so others can
  import from one place.
- **`locals`** — a per-request bag SvelteKit gives server code, holding the current user.
- **Authorization** — deciding whether the person asking is allowed to do this. Separate
  from *authentication*, which is deciding who they are.

## The layers

```
   Postgres                src/lib/server                     src/routes
┌─────────────┐  ┌──────────────────────────────────┐  ┌─────────────────────┐
│ table       │←─│ db/schema/<table>.ts   pgTable   │  │ api/<thing>/        │
│ "user"      │  │       │ $inferSelect             │  │   +server.ts        │
│             │  │       ↓                          │  │                     │
│ id uuid pk  │  │ models/<thing>.ts                │─→│  1. locals.user?    │
│ name text   │  │   Row interface + drift guard    │  │  2. Model.canAccess │
│ ...         │  │   fillable + entity queries      │  │  3. await Model.x() │
│             │  │       │ extends                  │  │  4. json(...)       │
└─────────────┘  │       ↓                          │  └─────────────────────┘
                 │ models/model.ts    abstract Model│            ↓
                 │   all find where first count     │      stores / client
                 │   create update destroy          │
                 └──────────────────────────────────┘
```

Rule of thumb for where a thing goes: **column shapes → schema, query shapes → model,
request shapes → route.**

## Why a model layer at all

Drizzle is a query builder, not an ORM. Without a model layer every route hand-rolls its
own `db.select().from(user).where(eq(user.id, id)).limit(1)`, and three things drift:

- **The same query, spelled differently in five routes.** `find` / `first` / `where` are
  boilerplate that has exactly one correct implementation per table.
- **Nowhere to put mass-assignment protection.** `User.update(id, await request.json())`
  in `src/routes/api/users/[id]/+server.ts` hands an untrusted body straight to the
  database. That is only safe because the model filters it.
- **Nowhere to put entity rules.** `findByEmail`, `canAccess` — these belong next to the
  entity, not copy-pasted into whichever route needed them first.

What we explicitly did *not* want is Active Record. `User.find(id)` returns a plain
`User` object, not a `UserModel` instance with a `.save()`. Keeping rows as plain
Drizzle-inferred objects is the whole reason to use Drizzle: the inferred types survive,
and rows serialize straight to `json()` without a `toJSON` step.

## Schema: `src/lib/server/db/schema/`

One file per table, all re-exported from `schema/index.ts`. Two consumers read that
barrel, and both look tables up **by exported const name**:

```ts
export const db = drizzle(client, { schema });        // db/index.ts
drizzleAdapter(db, { provider: 'pg', schema: { user, session, ... } })  // auth.ts
```

So `user`, `session`, `account` and `verification` — and their camelCase property keys —
are load-bearing names for Better Auth. The snake_case strings inside (`'email_verified'`)
are just DB column names and can be changed freely.

Conventions across the tables:

- `id: uuid('id').primaryKey().defaultRandom()` — every table. The base class relies on
  this: `create` never passes an id.
- `timestamp(..., { withTimezone: true })` for `createdAt` / `updatedAt`, both
  `.notNull().defaultNow()`.
- Foreign keys cascade: `.references(() => user.id, { onDelete: 'cascade' })`.

`drizzle.config.ts` globs `./src/lib/server/db/schema/*.ts`, so a new file in that
directory is picked up with no registration beyond the `index.ts` re-export.

## From schema to types

Drizzle infers the row shape, and the base class exposes it as `Row<T>`:

```ts
export type Row<T extends AnyTable> = T['$inferSelect'];
```

A model could stop there, but each entity declares its row type **explicitly** as an
interface, then asserts the two match:

```ts
export interface User { id: string; name: string; /* ... */ }

export type UserMatchesSchema = AssertTrue<Equals<User, Row<typeof user>>>;
```

Two things this buys:

1. **A nameable domain type.** Return types read `Promise<User | null>`, and consumers
   import `User` rather than spelling out `typeof user.$inferSelect`.
2. **A drift guard.** `Equals` is the exact-type trick (not mere assignability), so
   adding a column to the schema without adding it to the interface is a *compile error*,
   not a silent mismatch between the declared and actual shape.

`User` is both a type and a value — the interface and the singleton instance share a
name. TypeScript keeps types and values in separate namespaces, so this is legal and
intentional: `User.find(...)` is the model, `let u: User` is the row.

## The base class: `src/lib/server/models/model.ts`

```ts
abstract class Model<T extends AnyTable, F extends keyof Insert<T> & string, TRow = Row<T>>
```

| Parameter | What it is |
| --------- | ---------- |
| `T` | the Drizzle table — supplies both `$inferSelect` and `$inferInsert` |
| `F` | the union of fillable column names, checked against the insert shape |
| `TRow` | the row type actually returned; defaults to `Row<T>`, pass the named interface (`User`) so methods return the domain type |

Two abstract members per subclass: `table` and `fillable`.

### Read methods

| Method | Returns |
| ------ | ------- |
| `all()` | `TRow[]` |
| `find(id)` | `TRow \| null` — by primary key |
| `where(condition)` | `TRow[]` |
| `first(condition)` | `TRow \| null` |
| `count(condition?)` | `number` |

`where` / `first` / `count` take a Drizzle `SQL` condition, so models import operators
directly: `this.first(eq(user.email, email))`.

### Write methods

| Method | Returns |
| ------ | ------- |
| `create(attributes)` | the inserted `TRow` |
| `update(id, attributes)` | the updated `TRow`, or `null` if no row matched |
| `destroy(id)` | `true` if a row was deleted |

All three use `.returning()`, so a route gets the persisted row back without a follow-up
read. `create` deliberately omits the primary key — every table defaults it.

### `fillable` and over-posting

`create` and `update` both run the payload through `only()`, which keeps **only** the
keys listed in `fillable` and drops everything else. This is the reason a route can pass
a raw request body straight through.

The `User` model's list is `['name', 'email', 'image']`. `emailVerified` is absent on
purpose — it is precisely the field a hostile sign-up body would want to set. Adding a
column to a schema does **not** make it writable; that is a separate, deliberate edit.

> Choosing `fillable` is a security decision, not a convenience one. The question is not
> "does the app ever set this?" but "may an HTTP client set this?" — anything that fails
> the second test stays out and gets its own method.

### The escape hatch

```ts
protected get builder() { return { db, table: this.table }; }
```

Joins, transactions, partial selects and aggregates are all better expressed in Drizzle
directly. Reach for `builder` inside a model method rather than growing the base class
until it is a second, worse query builder.

## Entity models: `src/lib/server/models/<thing>.ts`

Each file exports the row interface, the drift guard, a private class, and a **singleton
instance** as the public handle:

```ts
class UserModel extends Model<typeof user, 'name' | 'email' | 'image', User> {
  protected readonly table = user;
  protected readonly fillable = ['name', 'email', 'image'] as const;

  findByEmail(email: string) { return this.first(eq(user.email, email)); }

  canAccess(requester: { id: string } | null, id: string): boolean {
    return requester?.id === id;
  }
}

export const User = new UserModel();
```

The class is not exported — there is never a reason to construct a second one. Models
hold no per-request state (only `table` and `fillable`, both compile-time constants), so
a module-level singleton is safe on the server. Contrast this with stores, where
module-level state *would* leak across requests; see stores.md.

`src/lib/server/models/index.ts` re-exports every model so routes import from one place.

### Authorization lives on the model

`canAccess` is a model method, not route code, so the rule is stated once and every route
touching the entity asks the same question. Today it is self-service only — the `user`
table has no `role` column, so there is no admin override to check. When one lands, it
lands here and every route inherits it.

## Who owns writes

Better Auth owns the write lifecycle for `user`, `account`, `session` and `verification`.
Sign-up hashes the password and creates the matching `account` row in one operation.

> **Never call `User.create()` to register a user** — you get a `user` row with no
> `account`, which cannot sign in. Use `auth.api.*`.

The model layer covers everything else on those tables: lookups, profile updates, admin
views, deletes. For non-auth tables the model owns the full lifecycle.

Session data reaching the client is a separate path and does not go through models:
`hooks.server.ts` → `event.locals` → `+layout.server.ts` → `page.data`.

## Migrations

Schema files are the source of truth; there is no separate migration DSL.

```sh
pnpm db:push     # drizzle-kit push  — diff schema against the DB and apply
pnpm db:studio   # drizzle-kit studio — browse the data
```

`drizzle.config.ts` runs with `strict: true` and `verbose: true`, so `push` prints the
statements and asks before executing. Read the diff — `push` compares desired state
against actual, and a renamed column looks exactly like a drop plus an add.

## House rules

- **Schema first.** Add the column to `db/schema/<table>.ts`, then to the model's row
  interface (the drift guard forces this), then decide separately whether it is
  `fillable`.
- **`fillable` is an allowlist, and stays minimal.** Never add a field just to make a
  route shorter.
- **Routes authorize, models answer.** Every handler checks `locals.user` first, then
  `Model.canAccess`, then queries. A model method never assumes it was called by an
  authorized caller.
- **Return `null`, not throw.** Base methods return `null` / `false` for "no such row";
  turning that into a 404 is the route's job via `error()`.
- **One singleton per entity, no request state on it.**
- **Complex queries go in a model method using `builder`,** not in a route and not as a
  new base-class method.
- **Auth-table writes go through Better Auth.**

## Adding a new model

Working example: `src/routes/api/trades/+server.ts` is still an in-memory array with a
`Trade` type in `src/lib/types.ts`. Giving it a table means:

1. **Schema** — `src/lib/server/db/schema/trade.ts`: `pgTable('trade', { ... })` with a
   `uuid` primary key, `withTimezone` timestamps, and a cascading `userId` reference.
   Re-export it from `schema/index.ts`.
2. **Push** — `pnpm db:push`, and read the diff.
3. **Model** — `src/lib/server/models/trade.ts`: the `Trade` interface, the
   `TradeMatchesSchema` guard, `class TradeModel extends Model<typeof trade, ..., Trade>`
   with `table`, `fillable`, and entity methods (`findByUser`, `canAccess` — for an owned
   resource, compare `requester?.id` against the row's `userId`). Export the singleton.
4. **Register** — one line in `src/lib/server/models/index.ts`.
5. **Route** — swap the in-memory array in `+server.ts` for model calls, keeping the
   auth-check-then-query order.
6. **Client type** — the row interface is server-only; the client keeps its own shape in
   `src/lib/types.ts`. Keep them in sync by hand, or re-declare the client type as the
   JSON-serialized subset it actually consumes (dates arrive as strings over the wire).

## Known drift

Two imports currently point at paths that do not exist — fix before following this doc:

- `src/lib/server/models/user.ts:3` imports `'./model'`, but the base class file is at
  `src/lib/server/db/model.ts`. It should live at `src/lib/server/models/model.ts` (its
  own `import { db } from '../db'` already assumes that location).
- `src/routes/api/users/[id]/+server.ts:2` imports `$lib/server/db/models`; the models
  barrel is `$lib/server/models`.

## Alternatives we considered

- **Raw Drizzle in routes.** Fewest moving parts and the most idiomatic Drizzle, but no
  home for `fillable`, `canAccess`, or reused queries — every route re-derives them.
- **Full Active Record** (rows as model instances with `.save()`). Familiar from
  Eloquent, but it means wrapping every row and hand-maintaining the instance types,
  which discards the inferred typing that justifies Drizzle.
- **A repository per entity, no shared base.** No generics puzzle, at the cost of
  reimplementing the same seven CRUD methods per table.

The base class is the middle path: shared CRUD and one mass-assignment guard, with rows
staying plain and `builder` available the moment a query outgrows it.
