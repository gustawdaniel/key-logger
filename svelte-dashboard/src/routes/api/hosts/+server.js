import { getHosts, BACKEND } from '$lib/backend.js';

export async function GET() {
    try {
        const hosts = await getHosts();
        return new Response(JSON.stringify({ hosts }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('Error fetching hosts:', e);
        return new Response(JSON.stringify({ error: e.message, hosts: [] }), { status: 500 });
    }
}
