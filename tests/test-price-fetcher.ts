import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PriceFetcher, type Asset } from '../src/lib/server/services/FinancialDataService';

type InputRow = {
	operation: 'daily' | 'series';
	type: 'stock' | 'forex' | 'crypto';
	symbol: string;
	startTime: string;
	endTime?: string;
	intervalValue?: string;
	intervalUnit?: 'minute' | 'hour' | 'day';
	periodValue?: string;
	periodUnit?: 'minute' | 'hour' | 'day';
};

const INPUT_CSV = '/home/rbom/nice/level_6/ft_transcendence/GitHub/GeoTrade/tests/input.csv';
const OUTPUT_CSV = '/home/rbom/nice/level_6/ft_transcendence/GitHub/GeoTrade/tests/output.csv';

function parseCsv(text: string): InputRow[] {
	const lines = text.trim().split(/\r?\n/);
	if (lines.length < 2) return [];
	const headers = lines[0].split(',');
	return lines.slice(1).filter(Boolean).map((line) => {
		const values = line.split(',');
		const row = Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])) as Record<string, string>;
		return {
			operation: row.operation as InputRow['operation'],
			type: row.type as InputRow['type'],
			symbol: row.symbol,
			startTime: row.startTime,
			endTime: row.endTime || undefined,
			intervalValue: row.intervalValue || undefined,
			intervalUnit: row.intervalUnit as InputRow['intervalUnit'],
			periodValue: row.periodValue || undefined,
			periodUnit: row.periodUnit as InputRow['periodUnit']
		};
	});
}

function csvEscape(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toCsv(rows: Array<{ input: InputRow; timestamp?: Date; price?: number; error?: string }>): string {
	const header = 'operation,type,symbol,inputStartTime,timestamp,price,error';
	const lines = rows.map((row) => [
		row.input.operation,
		row.input.type,
		row.input.symbol,
		row.input.startTime,
		row.timestamp?.toISOString() ?? '',
		row.price?.toString() ?? '',
		row.error ?? ''
	].map(csvEscape).join(','));
	return [header, ...lines].join('\n') + '\n';
}

test('Tiingo CSV integration test', async () => {
	const token = process.env.TIINGO_API_KEY_2;
	assert.ok(token, 'TIINGO_API_TOKEN must be set');

	const input = parseCsv(await readFile(INPUT_CSV, 'utf8'));
	assert.ok(input.length > 0, `No test rows found in ${INPUT_CSV}`);

	const fetcher = new PriceFetcher(token);
	const output: Array<{ input: InputRow; timestamp?: Date; price?: number; error?: string }> = [];

	for (const row of input) {
		const asset: Asset = { symbol: row.symbol, type: row.type };
		try {
			const series = row.operation === 'daily'
				? await fetcher.fetchDailySeries(asset, new Date(row.startTime), row.endTime ? new Date(row.endTime) : undefined)
				: await fetcher.fetchPriceSeries(
					asset,
					new Date(row.startTime),
					{ value: Number(row.intervalValue), unit: row.intervalUnit! },
					{ value: Number(row.periodValue), unit: row.periodUnit! }
				);

			for (const point of series.points) output.push({ input: row, timestamp: point.timestamp, price: point.price });
			assert.ok(Array.isArray(series.points), `No points array for ${row.type} ${row.symbol}`);
		} catch (error) {
			output.push({ input: row, error: error instanceof Error ? error.message : String(error) });
		}
	}

	await writeFile(OUTPUT_CSV, toCsv(output), 'utf8');
	assert.ok(output.length > 0, 'No output rows were produced');
	const errors = output.filter((row) => row.error);
	assert.equal(errors.length, 0, `One or more CSV test rows failed. See ${OUTPUT_CSV}`);
});
