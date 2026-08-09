<script lang="ts">
    import * as Field from "$lib/components/ui/field/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";

    let email = $state('');
    let password = $state('');

    function handleSubmit() {
        console.log('Login:', email, password);
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

        <Button type="submit" class="h-10">
            Sign in
        </Button>
    </Field.Group>
</form>