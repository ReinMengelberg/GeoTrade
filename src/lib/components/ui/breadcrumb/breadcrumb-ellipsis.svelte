<script lang="ts">
	import RiMoreLine from 'remixicon-svelte/icons/more-line';
	import { cn, type WithElementRef, type WithoutChildren } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLSpanElement>>> = $props();
</script>

<span
	bind:this={ref}
	data-slot="breadcrumb-ellipsis"
	role="presentation"
	aria-hidden="true"
	class={cn("size-4 [&>svg]:size-3.5 flex items-center justify-center", className)}
	{...restProps}
>
	<RiMoreLine  />
	<span class="sr-only">More</span>
</span>
