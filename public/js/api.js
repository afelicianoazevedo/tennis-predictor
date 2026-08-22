const SUPABASE_URL = 'https://ywmrxvurnxgnmpcjnisi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0';

async function apiSelect(table, options = {}) {
    const { select = '*', eq = {}, order = null, limit = null, gte = null, lte = null } = options;
    const params = new URLSearchParams();
    params.set('select', select);
    for (const [key, value] of Object.entries(eq)) params.set(key, `eq.${value}`);
    if (gte) for (const [key, value] of Object.entries(gte)) params.set(key, `gte.${value}`);
    if (lte) for (const [key, value] of Object.entries(lte)) params.set(key, `lte.${value}`);
    if (order) params.set('order', order);
    if (limit) params.set('limit', limit.toString());

    const url = `${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`;
    const response = await fetch(url, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
}

function formatTime(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
}

function getConfidenceClass(score) {
    if (score === null || score === undefined) return 'uncertain';
    if (score < 50) return 'uncertain';
    if (score < 60) return 'dangerous';
    if (score < 70) return 'tendency';
    return 'strong';
}

function getConfidenceLabel(score) {
    if (score === null || score === undefined) return 'INCERTO';
    if (score < 50) return 'INCERTO';
    if (score < 60) return 'PERIGOSO';
    if (score < 70) return 'TENDÊNCIA';
    return 'FORTE';
}

function filterMatchesByCategory(matches, category) {
    if (category === 'all') return matches;
    return matches.filter(match => {
        const p1Name = match.players?.name || '';
        const p2Name = match.player2?.name || '';
        const isDoubles = p1Name.includes('/') || p2Name.includes('/');
        if (category === 'doubles') return isDoubles;
        if (category === 'men') return !isDoubles && match.players?.gender === 'M';
        if (category === 'women') return !isDoubles && match.players?.gender === 'F';
        return true;
    });
}
