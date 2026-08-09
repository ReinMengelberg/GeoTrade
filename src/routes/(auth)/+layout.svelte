<script lang="ts">
    let { children } = $props();
</script>

<svelte:head>
    <title>GeoTrade - Login</title>
</svelte:head>

<div class="grid min-h-screen grid-cols-2">
    <!-- Left side -->
    <section class="flex items-start justify-start p-8">
            <h1 class="text-4xl font-semibold">GeoTrade</h1>
    </section>

    <!-- Right side -->
    <section class="flex items-start justify-center px-8 pt-40">
        <div class="w-full max-w-sm">
            {@render children()}
        </div>
    </section>
</div>