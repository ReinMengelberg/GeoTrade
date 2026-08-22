<script lang="ts">
  import { useStores } from "$lib/stores";

  const { trades } = useStores();
</script>

<div class="flex flex-1 flex-col gap-4 p-4 pt-0">
  <div class="grid auto-rows-min gap-4 md:grid-cols-3">
    <div class="aspect-video rounded-xl bg-muted/50 p-4">
      <h2 class="mb-2 text-sm font-medium">Trades</h2>
      <ul class="space-y-1 text-sm text-muted-foreground">
        {#each trades.trades as trade (trade.id)}
          <li>{trade.symbol} — {trade.quantity} @ {trade.price}</li>
        {/each}
      </ul>
    </div>
    <div class="aspect-video rounded-xl bg-muted/50"></div>
    <div class="aspect-video rounded-xl bg-muted/50"></div>
  </div>
  <div class="min-h-screen flex-1 rounded-xl bg-muted/50 md:min-h-min"></div>
</div>
