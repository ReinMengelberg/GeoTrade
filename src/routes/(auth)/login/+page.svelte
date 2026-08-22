<script lang="ts">
    import * as Field from "$lib/components/ui/field/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { goto } from "$app/navigation";
    import { auth } from "$lib/stores/auth.svelte";

    let email = $state('');
    let password = $state('');
    let errorMessage = $state('');

    async function handleSubmit(event: SubmitEvent) {
        event.preventDefault();

        errorMessage = '';

        const error = await auth.signIn(email, password);

        if (error) {
            errorMessage = error.message ?? 'Invalid email or password';
            return;
        }

        await goto('/dashboard');
    }

    async function createTestUser() {
        const error = await auth.signUp('Test User', 'test@example.com', 'password123');

        if (error) {
            errorMessage = error.message ?? 'Could not create test user';
        }
    }
</script>

<h1 class="mb-6 text-2xl font-semibold">
    Sign in to GeoTrade
</h1>

<form onsubmit={handleSubmit}>
    <Field.Group>
        <Field.Field>
            <Field.Label for="email" class="text-base">
                Email
            </Field.Label>

            <Input
                id="email"
                type="email"
                bind:value={email}
                required
                class="h-8"
            />
        </Field.Field>

        <Field.Field>
            <Field.Label for="password" class="text-base">
                Password
            </Field.Label>

            <Input
                id="password"
                type="password"
                bind:value={password}
                required
                class="h-8"
            />
        </Field.Field>

        {#if errorMessage}
            <p class="text-sm text-destructive">
                {errorMessage}
            </p>
        {/if}

        <Button type="submit" class="h-10" disabled={auth.pending}>
            Sign in
        </Button>

        <Button type="button" class="h-10" disabled={auth.pending} onclick={createTestUser}>
            Create test user
        </Button>
    </Field.Group>
</form>
