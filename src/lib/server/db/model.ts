import { count, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from './index';

// An Eloquent-style base class: each entity gets one subclass that declares its
// table and its mass-assignable columns (`fillable`).
//
// Unlike Eloquent this is not Active Record — rows come back as plain objects
// typed by the Drizzle schema, not as model instances. That keeps Drizzle's
// inferred types intact, which is the main reason to use Drizzle at all.

/** True only when X and Y are the same type, not merely assignable. */
export type Equals<X, Y> =
	(<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2 ? true : false;

/** Compile error unless the argument is exactly `true`. */
export type AssertTrue<T extends true> = T;

type AnyTable = PgTable & { id: PgColumn };
export type Row<T extends AnyTable> = T['$inferSelect'];
type Insert<T extends AnyTable> = T['$inferInsert'];
type Id<T extends AnyTable> = Row<T>['id'];

export abstract class Model<
	T extends AnyTable,
	F extends keyof Insert<T> & string,
	TRow extends Row<T> = Row<T>
> {
	/** The Drizzle table this model reads and writes. */
	protected abstract readonly table: T;

	/**
	 * Columns that may be set through `create` / `update`. Anything else in the
	 * payload is dropped, so untrusted request bodies cannot over-post (e.g. a
	 * sign-up body smuggling `emailVerified: true`).
	 */
	protected abstract readonly fillable: readonly F[];

	async all(): Promise<TRow[]> {
		const rows = await db.select().from(this.table as PgTable);
		return rows as TRow[];
	}

	async find(id: Id<T>): Promise<TRow | null> {
		const rows = await db
			.select()
			.from(this.table as PgTable)
			.where(eq(this.table.id, id))
			.limit(1);

		return rows.length ? (rows[0] as TRow) : null;
	}

	async where(condition: SQL): Promise<TRow[]> {
		const rows = await db
			.select()
			.from(this.table as PgTable)
			.where(condition);

		return rows as TRow[];
	}

	async first(condition: SQL): Promise<TRow | null> {
		const rows = await db
			.select()
			.from(this.table as PgTable)
			.where(condition)
			.limit(1);

		return rows.length ? (rows[0] as TRow) : null;
	}

	async count(condition?: SQL): Promise<number> {
		const query = db.select({ value: count() }).from(this.table as PgTable);
		const rows = await (condition ? query.where(condition) : query);

		return rows[0].value;
	}

	async create(attributes: Pick<Insert<T>, F>): Promise<TRow> {
		// `values` holds exactly the `fillable` keys, and `create`'s signature
		// already types them. Drizzle cannot verify that for a still-generic `T`,
		// so the assertion is contained to this boundary. The primary key is left
		// out on purpose — every table defaults it to `gen_random_uuid()`.
		const rows = await db
			.insert(this.table)
			.values(this.only(attributes) as Insert<T>)
			.returning();

		return rows[0] as TRow;
	}

	async update(id: Id<T>, attributes: Partial<Pick<Insert<T>, F>>): Promise<TRow | null> {
		const rows = await db
			.update(this.table)
			.set(this.only(attributes) as Insert<T>)
			.where(eq(this.table.id, id))
			.returning();

		return rows.length ? (rows[0] as TRow) : null;
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
	private only(attributes: object): Record<string, unknown> {
		const values: Record<string, unknown> = {};

		for (const key of this.fillable) {
			if (key in attributes) values[key] = (attributes as Record<string, unknown>)[key];
		}

		return values;
	}
}

