// import type { RequestHandler } from './$types';

// const testUser = {
//     email: 'test@example.com',
//     password: 'password123'
// };

// export const POST: RequestHandler = async ({ request }) => {
//     const { email, password } = await request.json();

//     if (email !== testUser.email || password !== testUser.password) {
//         return new Response(
//             JSON.stringify({ error: 'Invalid email or password' }),
//             {
//                 status: 401,
//                 headers: { 'Content-Type': 'application/json' }
//             }
//         );
//     }

//     return new Response(
//         JSON.stringify({ message: 'Login successful' }),
//         {
//             status: 200,
//             headers: { 'Content-Type': 'application/json' }
//         }
//     );
// };
// import type { RequestHandler } from './$types';

// export const POST: RequestHandler = async () => {
//     return new Response('LOGIN ENDPOINT WORKS!', {
//         status: 200
//     });
// };

import type { RequestHandler } from './$types';

const testUser = {
    email: 'test@example.com',
    password: 'password123'
};

// Use the HTTP POST method
export const POST: RequestHandler = async ({ request }) => {
    const { email, password } = await request.json(); //read email and password

    if (email !== testUser.email || password !== testUser.password) {
        return new Response( //constructs the HTTP response
            JSON.stringify({
                error: 'Invalid email or password'
            }),
            {
                status: 401,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
    }

    return new Response(
        JSON.stringify({
            message: 'Login successful'
        }),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            }
        }
    );
};