// tests/test-price-fetcher.ts
import { PriceFetcher, type Asset } from '../src/lib/server/services/FinancialDataService';

async function runTests() {
  console.log('🚀 Starting FinancialDataService Integration Tests...\n');

  // Verify Environment Variable
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) {
    console.error('❌ ERROR: TIINGO_API_KEY environment variable is not set.');
    console.error('Please run the script with: TIINGO_API_KEY=your_key pnpm test:prices\n');
    process.exit(1);
  }

  const fetcher = new PriceFetcher(apiKey);

  const testAssets: Asset[] = [
    { symbol: 'AAPL', type: 'stock' },
    { symbol: 'EURUSD', type: 'forex' },
    { symbol: 'btcusd', type: 'crypto' },
  ];

  try {
	// 1. Test Live Prices
    console.log('--- 1. Testing fetchAssetPrice ---');
    const AssetPrices = await fetcher.fetchAssetPrice(testAssets);
    
    if (!AssetPrices) {
      throw new Error('fetchAssetPrice returned undefined or null');
    }

    console.log(`Fetched ${AssetPrices.length} live prices:`);
    AssetPrices.forEach((lp) => {
      console.log(`  • [${lp.asset.type.toUpperCase()}] ${lp.asset.symbol}: $${lp.price} @ ${lp.date.toISOString()}`);
    });
    console.log('✅ Live prices test passed.\n');

    // 2. Test Full Historical Daily Prices (Stock)
    console.log('--- 2. Testing fetchAssetPriceSeriesTotal (AAPL) ---');
    const stockHistory = await fetcher.fetchAssetPriceSeriesTotal(testAssets[0]);
    console.log(`Fetched ${stockHistory.priceSeries.length} historical EOD points for ${stockHistory.asset.symbol}`);
    if (stockHistory.priceSeries.length > 0) {
      const latest = stockHistory.priceSeries[stockHistory.priceSeries.length - 1];
      console.log(`  • Latest EOD: $${latest.price} on ${latest.date.toISOString().split('T')[0]}`);
    }
    console.log('✅ Total history test passed.\n');

    // 3. Test 10-Minute Interval Prices over 7 days (Forex)
    console.log('--- 3. Testing fetchAssetPriceSeriesMinute (EURUSD) ---');
    const sevenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days ago to ensure data range
    const forexMinuteHistory = await fetcher.fetchAssetPriceSeriesMinute(testAssets[1], sevenDaysAgo);
    console.log(`Fetched ${forexMinuteHistory.priceSeries.length} 10-min interval points for ${forexMinuteHistory.asset.symbol}`);
    console.log('✅ Minute interval history test passed.\n');

    // 4. Test 1-Hour Interval Prices over 30 days (Crypto)
    console.log('--- 4. Testing fetchAssetPriceSeriesHour (BTCUSD) ---');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cryptoHourHistory = await fetcher.fetchAssetPriceSeriesHour(testAssets[2], thirtyDaysAgo);
    console.log(`Fetched ${cryptoHourHistory.priceSeries.length} 1-hour interval points for ${cryptoHourHistory.asset.symbol}`);
    console.log('✅ Hour interval history test passed.\n');

    console.log('🎉 All integration tests passed successfully!');
  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();