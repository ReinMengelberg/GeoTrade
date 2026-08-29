import { count, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from './index';

// An Eloquent-style base class: each entity gets one subclass that declares its
// table, its mass-assignable columns (`fillable`) and any attribute casts.
//
// Unlike Eloquent this is not Active Record — rows come back as plain objects
// typed by the Drizzle schema, not as model instances. That keeps Drizzle's
// inferred types intact, which is the main reason to use Drizzle at all.

export type Cast = 'number' | 'string' | 'boolean' | 'date' | 'json';

type AnyTable = PgTable & { id: PgColumn };
type Row<T extends AnyTable> = T['$inferSelect'];
type Insert<T extends AnyTable> = T['$inferInsert'];
type Id<T extends AnyTable> = Row<T>['id'];

export abstract class Model<T extends AnyTable, F extends keyof Insert<T> & string> {
	/** The Drizzle table this model reads and writes. */
	protected abstract readonly table: T;

	/**
	 * Columns that may be set through `create` / `update`. Anything else in the
	 * payload is dropped, so untrusted request bodies cannot over-post (e.g. a
	 * sign-up body smuggling `emailVerified: true`).
	 */
	protected abstract readonly fillable: readonly F[];

	/**
	 * Attribute casts applied on read. Drizzle already returns correct types for
	 * most columns, so this is usually empty — it earns its keep on `numeric`,
	 * which postgres-js hands back as a string: `{ price: 'number' }`.
	 */
	protected abstract readonly casts: Partial<Record<keyof Row<T> & string, Cast>>;

	async all(): Promise<Row<T>[]> {
		const rows = await db.select().from(this.table as PgTable);
		return rows.map((row) => this.hydrate(row));
	}

	async find(id: Id<T>): Promise<Row<T> | null> {
		const rows = await db
			.select()
			.from(this.table as PgTable)
			.where(eq(this.table.id, id))
			.limit(1);

		return rows.length ? this.hydrate(rows[0]) : null;
	}

	async where(condition: SQL): Promise<Row<T>[]> {
		const rows = await db
			.select()
			.from(this.table as PgTable)
			.where(condition);

		return rows.map((row) => this.hydrate(row));
	}

	async first(condition: SQL): Promise<Row<T> | null> {
		const rows = await db
			.select()
			.from(this.table as PgTable)
			.where(condition)
			.limit(1);

		return rows.length ? this.hydrate(rows[0]) : null;
	}

	async count(condition?: SQL): Promise<number> {
		const query = db.select({ value: count() }).from(this.table as PgTable);
		const rows = await (condition ? query.where(condition) : query);

		return rows[0].value;
	}

	async create(attributes: Pick<Insert<T>, F>): Promise<Row<T>> {
		const rows = await db
			.insert(this.table)
			.values(this.only(attributes))
			.returning();

		return this.hydrate(rows[0]);
	}

	async update(id: Id<T>, attributes: Partial<Pick<Insert<T>, F>>): Promise<Row<T> | null> {
		const rows = await db
			.update(this.table)
			.set(this.only(attributes))
			.where(eq(this.table.id, id))
			.returning();

		return rows.length ? this.hydrate(rows[0]) : null;
	}

	async destroy(id: Id<T>): Promise<boolean> {
		const rows = await db.delete(this.table).where(eq(this.table.id, id)).returning();

		return rows.length > 0;
	}

	/**
	 * Escape hatch. Joins, transactions, partial selects and aggregates are all
	 * better expressed in Drizzle directly — reach for this instead of growing
	 * the base class until it is a second query builder.
	 */
	protected get builder() {
		return { db, table: this.table };
	}

	/** Strips everything not listed in `fillable`. */
	private only(attributes: object): Insert<T> {
		const values: Record<string, unknown> = {};

		for (const key of this.fillable) {
			if (key in attributes) values[key] = (attributes as Record<string, unknown>)[key];
		}

		// Safe by construction: the keys are exactly `fillable`, and the public
		// `create` / `update` signatures already type them. Drizzle cannot verify
		// this for a still-generic `T`, so the assertion is contained here.
		return values as Insert<T>;
	}

	/** Applies `casts` to a row coming out of the database. */
	private hydrate(row: Record<string, unknown>): Row<T> {
		const entries = Object.entries(this.casts) as [string, Cast][];
		if (!entries.length) return row as Row<T>;

		const hydrated = { ...row };

		for (const [key, cast] of entries) {
			if (hydrated[key] !== null && hydrated[key] !== undefined) {
				hydrated[key] = applyCast(hydrated[key], cast);
			}
		}

		return hydrated as Row<T>;
	}
}

function applyCast(value: unknown, cast: Cast): unknown {
	switch (cast) {
		case 'number':
			return typeof value === 'number' ? value : Number(value);
		case 'string':
			return typeof value === 'string' ? value : String(value);
		case 'boolean':
			return typeof value === 'boolean' ? value : value === 'true' || value === 1;
		case 'date':
			return value instanceof Date ? value : new Date(value as string | number);
		case 'json':
			return typeof value === 'string' ? JSON.parse(value) : value;
	}
}
