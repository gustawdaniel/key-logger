import { base } from '$app/paths';

export async function GET({ url, fetch }) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateStr = url.searchParams.get('date') || todayStr;
    const host = url.searchParams.get('host') || 'all';

    const res = await fetch(`${base}/api/journal?date=${dateStr}&host=${host}&format=raw`);
    const text = await res.text();

    return new Response(text, {
        status: res.status,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}
