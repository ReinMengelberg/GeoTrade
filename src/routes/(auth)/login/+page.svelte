<script lang="ts">
    import * as Field from "$lib/components/ui/field/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { signIn } from "$lib/auth-client";
    let email = $state('');
    let password = $state('');

    // function handleSubmit() {
    //     console.log('Login:', email, password);
    // }
//         async function handleSubmit(event: SubmitEvent) {
//         event.preventDefault();

//         const response = await fetch('/api/auth/login', {
//             method: 'POST',
//             headers: {
//                 'Content-Type': 'application/json'
//             },
//             body: JSON.stringify({
//                 email,
//                 password
//             })
//         });
//         console.log('response status:', response.status);
//         // const data = await response.json();

//         // console.log(data);
//         const text = await response.text();

// console.log('response body:', text);
//     }
// async function handleSubmit(event: SubmitEvent) { 
//     event.preventDefault(); 
//     const result = await signIn.email({ email, password }); 
//     console.log(result); 
//     }

async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    // construct HTTP request and send it
    const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email,
            password
        })
    });
    
    const data = await response.json();// take the response body and parse it as JSON

    console.log('status:', response.status);
    console.log('response:', data);
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