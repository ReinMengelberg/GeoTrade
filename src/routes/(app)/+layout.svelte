<script lang="ts">
    import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
    import * as Sidebar from "$lib/components/ui/sidebar/index.js";
    import { Separator } from "$lib/components/ui/separator/index.js";
    import AppSidebar from "$lib/components/app-sidebar.svelte";
    import { initStores } from "$lib/stores";

    let { data, children } = $props();

    // Seed-once: after this, the stores own the data and mutations go through
    // their methods. A re-run of the layout load does not re-seed.
    // svelte-ignore state_referenced_locally
    initStores({ trades: data.trades });
</script>

<Sidebar.Provider>
    <AppSidebar />

    <Sidebar.Inset>
        <header class="flex h-16 shrink-0 items-center gap-2 border-b">
            <div class="flex items-center gap-2 px-3">
                <Sidebar.Trigger />

                <Separator orientation="vertical" class="me-2 h-4" />

                <Breadcrumb.Root>
                    <Breadcrumb.List>
                        <Breadcrumb.Item class="hidden md:block">
                            <Breadcrumb.Link href="#">
                                Build Your Application
                            </Breadcrumb.Link>
                        </Breadcrumb.Item>

                        <Breadcrumb.Separator class="hidden md:block" />

                        <Breadcrumb.Item>
                            <Breadcrumb.Page>
                                Data Fetching
                            </Breadcrumb.Page>
                        </Breadcrumb.Item>
                    </Breadcrumb.List>
                </Breadcrumb.Root>
            </div>
        </header>

        {@render children()}
    </Sidebar.Inset>
</Sidebar.Provider>