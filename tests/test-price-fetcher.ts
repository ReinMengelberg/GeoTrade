import {test} from 'node:test'; // Imports Node's test runner.
import assert from 'node:assert/strict'; // Imports strict assertions.
import fs from 'node:fs/promises'; // Imports promise-based filesystem functions.
import {PriceFetcher, type Asset, type Duration} from '../src/lib/server/services/FinancialDataService'; // Imports the service and its types.

const INPUT_LIVE = 'tests/input_live.csv'; // Defines the live input file.
const INPUT_DAILY = 'tests/input_daily.csv'; // Defines the daily input file.
const INPUT_SERIES = 'tests/input_series.csv'; // Defines the series input file.
const OUTPUT_LIVE = 'tests/output_live.csv'; // Defines the live output file.
const OUTPUT_DAILY = 'tests/output_daily.csv'; // Defines the daily output file.
const OUTPUT_SERIES = 'tests/output_series.csv'; // Defines the series output file.

type CsvRow = Record<string, string>; // Represents one CSV row.

function parseCsv(text: string): CsvRow[] { // Parses the simple test CSV format.
	const lines = text.trim().split(/\r?\n/); // Splits the input into lines.
	const headers = lines[0].split(','); // Reads the column names.
	return lines.slice(1).filter(Boolean).map((line) => { // Converts every data line into an object.
		const values = line.split(','); // Splits the current row.
		return Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])); // Associates values with headers.
	}); // Returns all parsed rows.
}

async function readCsv(path: string): Promise<CsvRow[]> { // Reads one CSV file.
	return parseCsv(await fs.readFile(path, 'utf8')); // Reads and parses the file.
}

function csvEscape(value: string): string { // Escapes a value for CSV output.
	return value.includes(',') || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value; // Quotes values containing CSV syntax.
}

async function writeCsv(path: string, headers: string[], rows: string[][]): Promise<void> { // Writes a CSV file.
	await fs.writeFile(path, [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n') + '\n'); // Builds and writes the file.
}

function toAsset(row: CsvRow): Asset { // Converts a CSV row into an Asset.
	return {symbol: row.symbol, type: row.type as Asset['type']}; // Copies the asset fields.
}

function durationMs({value, unit}: Duration): number { // Converts a Duration to milliseconds.
	return value * {min: 60_000, hour: 3_600_000, day: 86_400_000}[unit]; // Applies the unit multiplier.
}

function assertPoint(point: {timestamp: Date; price: number}, symbol: string): void { // Validates one returned point.
	assert.ok(!Number.isNaN(point.timestamp.getTime()), `${symbol}: invalid timestamp`); // Rejects invalid timestamps.
	assert.ok(Number.isFinite(point.price) && point.price > 0, `${symbol}: invalid price`); // Rejects invalid prices.
}

async function runCsvTest(path: string, output: string, run: (row: CsvRow) => Promise<string[][]>): Promise<void> { // Runs a historical CSV test and handles shared output/error logic.
	const input = await readCsv(path); // Reads the input cases.
	const rows: string[][] = []; // Stores successful and failed output rows.
	const errors: string[] = []; // Stores failures for the final assertion.
	for (const row of input) { // Processes every input case.
		try { // Allows later rows to run after a failure.
			rows.push(...await run(row)); // Runs the row-specific test.
		} catch (error) { // Handles one failed row.
			const message = error instanceof Error ? error.message : String(error); // Converts the error to text.
			errors.push(`${row.symbol}: ${message}`); // Stores the failure.
			rows.push([row.symbol, row.type, '', '', message]); // Writes the failure to the output CSV.
		}
	}
	await writeCsv(output, ['symbol', 'type', 'date', 'price', 'error'], rows); // Writes all results.
	assert.equal(errors.length, 0, errors.join('\n')); // Fails the test when any case failed.
}

test('fetchLivePrices', async () => { // Tests live prices and request count.
	const assets = (await readCsv(INPUT_LIVE)).map(toAsset); // Reads and converts all requested assets.
	const fetcher = new PriceFetcher(process.env.TIINGO_API_KEY_1!); // Creates the Tiingo service.
	const requested = new Set(assets.map(({type, symbol}) => `${type}:${symbol}`)); // Stores the requested asset keys.
	const types = new Set(assets.map((asset) => asset.type)); // Stores the used asset types.
	const requests: unknown[] = []; // Stores outgoing request URLs.
	const originalFetch = globalThis.fetch; // Saves the real fetch function.
	globalThis.fetch = async (...args) => { // Wraps fetch to count requests.
		requests.push(args[0]); // Records the request.
		return originalFetch(...args); // Passes it through unchanged.
	};
	let livePrices; // Stores the live results.
	try { // Ensures fetch is restored afterward.
		livePrices = await fetcher.fetchLivePrices(assets); // Fetches all live prices.
	} finally { // Always runs cleanup.
		globalThis.fetch = originalFetch; // Restores the real fetch function.
	}
	assert.equal(requests.length, types.size, `Expected ${types.size} live API requests, got ${requests.length}`); // Requires one request per used asset type.
	assert.ok(requests.length <= 3, `Too many live API requests: ${requests.length}`); // Enforces the three-request maximum.
	const returned = new Set<string>(); // Tracks returned asset keys.
	for (const result of livePrices) { // Checks every live result.
		assert.ok(result.asset, `Live result has no asset: ${JSON.stringify(result)}`); // Ensures the asset lookup succeeded.
		const key = `${result.asset.type}:${result.asset.symbol}`; // Builds the result key.
		assert.ok(requested.has(key), `Unexpected live asset: ${key}`); // Rejects unrequested assets.
		assert.ok(!returned.has(key), `Duplicate live asset: ${key}`); // Rejects duplicate assets.
		assertPoint(result.point, result.asset.symbol); // Validates the returned point.
		returned.add(key); // Records the valid result.
	}
	assert.equal(returned.size, requested.size, `Missing live assets: ${[...requested].filter((key) => !returned.has(key)).join(', ')}`); // Requires every requested asset.
	await writeCsv(OUTPUT_LIVE, ['symbol', 'type', 'timestamp', 'price'], livePrices.map(({asset, point}) => [asset.symbol, asset.type, point.timestamp.toISOString(), String(point.price)])); // Writes the live results.
});

test('fetchDailySeries', async () => { // Tests daily historical prices.
	const fetcher = new PriceFetcher(process.env.TIINGO_API_KEY_1!); // Creates the Tiingo service.
	await runCsvTest(INPUT_DAILY, OUTPUT_DAILY, async (row) => { // Runs all daily cases through the shared test logic.
		const asset = toAsset(row); // Converts the input asset.
		const startTime = new Date(row.start_time); // Converts the start time.
		const endTime = row.end_time ? new Date(row.end_time) : undefined; // Converts the optional end time.
		const result = await fetcher.fetchDailySeries(asset, startTime, endTime); // Fetches the daily series.
		assert.equal(result.asset.symbol, asset.symbol, `${asset.symbol}: wrong result symbol`); // Checks the returned symbol.
		assert.equal(result.asset.type, asset.type, `${asset.symbol}: wrong result type`); // Checks the returned type.
		assert.ok(result.points.length > 0, `${asset.symbol}: no daily prices returned`); // Requires at least one point.
		let previous = -Infinity; // Stores the previous timestamp.
		for (const point of result.points) { // Checks every daily point.
			const time = point.timestamp.getTime(); // Gets the timestamp in milliseconds.
			assert.ok(time >= startTime.getTime(), `${asset.symbol}: point before start`); // Ensures the point is not before the range.
			if (endTime) assert.ok(time <= endTime.getTime(), `${asset.symbol}: point after end`); // Ensures the point is not after the range.
			assert.ok(time > previous, `${asset.symbol}: daily points are not strictly chronological`); // Ensures strict ordering.
			assertPoint(point, asset.symbol); // Validates the point.
			previous = time; // Updates the previous timestamp.
		}
		return result.points.map((point) => [asset.symbol, asset.type, point.timestamp.toISOString(), String(point.price), '']); // Converts the result to CSV rows.
	});
});

test('fetchPriceSeries', async () => { // Tests generated interval-based prices.
	const fetcher = new PriceFetcher(process.env.TIINGO_API_KEY_1!); // Creates the Tiingo service.
	await runCsvTest(INPUT_SERIES, OUTPUT_SERIES, async (row) => { // Runs all series cases through the shared test logic.
		const asset = toAsset(row); // Converts the input asset.
		const startTime = new Date(row.start_time); // Converts the start time.
		const interval: Duration = {value: Number(row.interval_value), unit: row.interval_unit as Duration['unit']}; // Builds the interval.
		const period: Duration = {value: Number(row.period_value), unit: row.period_unit as Duration['unit']}; // Builds the period.
		const intervalMs = durationMs(interval); // Converts the interval to milliseconds.
		const expectedPoints = Math.ceil(durationMs(period) / intervalMs); // Calculates the expected number of points.
		const result = await fetcher.fetchPriceSeries(asset, startTime, interval, period); // Fetches the generated series.
		assert.equal(result.asset.symbol, asset.symbol, `${asset.symbol}: wrong result symbol`); // Checks the returned symbol.
		assert.equal(result.asset.type, asset.type, `${asset.symbol}: wrong result type`); // Checks the returned type.
		assert.equal(result.points.length, expectedPoints, `${asset.symbol}: expected ${expectedPoints} points, got ${result.points.length}`); // Checks the exact point count.
		return result.points.map((point, i) => { // Validates and converts every series point.
			const expectedTime = startTime.getTime() + i * intervalMs; // Calculates the required timestamp.
			assert.equal(point.timestamp.getTime(), expectedTime, `${asset.symbol}: wrong timestamp at index ${i}`); // Checks the exact timestamp.
			if (i) assert.ok(point.timestamp > result.points[i - 1].timestamp, `${asset.symbol}: duplicate timestamp at index ${i}`); // Checks ordering.
			assertPoint(point, asset.symbol); // Validates the point.
			return [asset.symbol, asset.type, point.timestamp.toISOString(), String(point.price), '']; // Converts the point to a CSV row.
		});
	});
});