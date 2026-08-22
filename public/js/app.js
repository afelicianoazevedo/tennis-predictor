const SUPABASE_URL = 'https://ywmrxvurnxgnmpcjnisi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0';

let currentTab = 'today';
let currentFilter = 'all';
let cachedData = {};

async function api(table, opts = {}) {
    const { select = '*', eq = {}, gte = {}, lte = {}, order = 'scheduled_at.asc', limit = 100 } = opts;
    const p = new URLSearchParams({ select, order, limit: limit.toString() });
    Object.entries(eq).forEach(([k, v]) => p.set(k, `eq.${v}`));
    Object.entries(gte).forEach(([k, v]) => p.set(k, `gte.${v}`));
    Object.entries(lte).forEach(([k, v]) => p.set(k, `lte.${v}`));

    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${p}`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}

async function loadToday() {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 864e5).toISOString().split('T')[0];
    return api('matches', {
        select: 'id,scheduled_at,status,round,surface,confidence_score,confidence_level,players:player1_id(name,country,ranking,gender),player2:player2_id(name,country,ranking,gender),tournament:tournaments(name)',
        gte: { scheduled_at: today }, lte: { scheduled_at: tomorrow }
    });
}

async function loadUpcoming() {
    const tomorrow = new Date(Date.now() + 864e5).toISOString().split('T')[0];
    const max = new Date(Date.now() + 3 * 864e5).toISOString().split('T')[0];
    return api('matches', {
        select: 'id,scheduled_at,status,round,surface,confidence_score,confidence_level,players:player1_id(name,country,ranking,gender),player2:player2_id(name,country,ranking,gender),tournament:tournaments(name)',
        gte: { scheduled_at: tomorrow }, lte: { scheduled_at: max }, limit: 200
    });
}

async function loadResults() {
    const week = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0];
    return api('matches', {
        select: 'id,scheduled_at,status,round,surface,score,winner_id,confidence_score,confidence_level,was_correct,players:player1_id(name,country,ranking,gender),player2:player2_id(name,country,ranking,gender),tournament:tournaments(name)',
        eq: { status: 'completed' }, gte: { scheduled_at: week }, order: 'scheduled_at.desc'
    });
}

async function loadPredictions() {
    const today = new Date().toISOString().split('T')[0];
    const three = new Date(Date.now() + 3 * 864e5).toISOString().split('T')[0];
    return api('matches', {
        select: 'id,scheduled_at,status,round,surface,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,players:player1_id(name,country,ranking,gender),player2:player2_id(name,country,ranking,gender),tournament:tournaments(name)',
        gte: { scheduled_at: today }, lte: { scheduled_at: three }, order: 'confidence_score.desc.nullslast', limit: 100
    });
}

async function loadStats() {
    const [matches, predictions] = await Promise.all([
        api('matches', { select: 'id,status,confidence_score' }),
        api('match_predictions', { select: 'id,was_correct' })
    ]);

    const today = new Date().toISOString().split('T')[0];
    const todayGames = matches.filter(m => m.scheduled_at?.startsWith(today)).length;
    const live = matches.filter(m => m.status === 'live').length;
    const completed = matches.filter(m => m.status === 'completed').length;
    const withPredictions = predictions.length;
    const correct = predictions.filter(p => p.was_correct === true).length;

    return { todayGames, live, completed, withPredictions, correct, total: matches.length };
}

function time(d) {
    if (!d) return '--:--';
    return new Date(d).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

function date(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
}

function confClass(s) {
    if (s == null) return '';
    if (s < 50) return 'uncertain';
    if (s < 60) return 'dangerous';
    if (s < 70) return 'tendency';
    return 'strong';
}

function confLabel(s) {
    if (s == null) return '';
    if (s < 50) return 'INCERTO';
    if (s < 60) return 'PERIGOSO';
    if (s < 70) return 'TENDÊNCIA';
    return 'FORTE';
}

function statusLabel(s) {
    return { upcoming: 'Agendado', live: 'LIVE', completed: 'Terminado', cancelled: 'Cancelado' }[s] || s;
}

function filterMatches(matches, cat) {
    if (cat === 'all') return matches;
    return matches.filter(m => {
        const p1 = m.players?.name || '';
        const p2 = m.player2?.name || '';
        const doubles = p1.includes('/') || p2.includes('/');
        if (cat === 'doubles') return doubles;
        if (cat === 'men') return !doubles && m.players?.gender === 'M';
        if (cat === 'women') return !doubles && m.players?.gender === 'F';
        return true;
    });
}

function renderMatch(m) {
    const p1 = m.players || {};
    const p2 = m.player2 || {};
    const tour = m.tournament || {};
    const cs = m.confidence_score;
    const cc = confClass(cs);
    const pred = m.predicted_winner_id;

    return `
        <div class="match c-${cc}" data-id="${m.id}">
            <div class="match-time">${time(m.scheduled_at)}</div>
            <div class="match-body">
                <div class="match-tour">${tour.name || ''} ${m.round ? '• ' + m.round : ''} ${m.surface ? '• ' + m.surface : ''}</div>
                <div class="match-players">
                    <div class="player">
                        <div class="player-name">${pred === p1.id ? '⭐ ' : ''}${p1.name || 'TBD'}</div>
                        <div class="player-info">${p1.country || ''} ${p1.ranking ? '(#' + p1.ranking + ')' : ''}</div>
                    </div>
                    <span class="match-vs">vs</span>
                    <div class="player">
                        <div class="player-name">${pred === p2.id ? '⭐ ' : ''}${p2.name || 'TBD'}</div>
                        <div class="player-info">${p2.country || ''} ${p2.ranking ? '(#' + p2.ranking + ')' : ''}</div>
                    </div>
                </div>
                <div class="match-footer">
                    <span class="match-status status-${m.status}">${statusLabel(m.status)}</span>
                    ${cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}</span>` : ''}
                    ${m.score ? `<span>${m.score}</span>` : ''}
                </div>
            </div>
        </div>
    `;
}

function renderMatches(matches, containerId) {
    const el = document.getElementById(containerId);
    if (!matches.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">🎾</div><p>Nenhum jogo</p></div>';
        return;
    }
    el.innerHTML = matches.map(renderMatch).join('');
    el.querySelectorAll('.match').forEach(card => {
        card.addEventListener('click', () => {
            const m = matches.find(x => x.id == card.dataset.id);
            if (m) showModal(m);
        });
    });
}

function renderFiltered() {
    const data = cachedData[currentTab] || [];
    const filtered = filterMatches(data, currentFilter);
    renderMatches(filtered, `${currentTab}-matches`);
}

function showModal(m) {
    const p1 = m.players || {};
    const p2 = m.player2 || {};
    const tour = m.tournament || {};
    const cs = m.confidence_score;
    const cc = confClass(cs);

    document.getElementById('modal-content').innerHTML = `
        <h3>${tour.name || 'Jogo'}</h3>
        <p style="color:var(--text-dim);margin:8px 0 16px">${date(m.scheduled_at)} ${time(m.scheduled_at)} ${m.round ? '• ' + m.round : ''} ${m.surface ? '• ' + m.surface : ''}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px">
            <div style="text-align:center;flex:1">
                <div style="font-weight:700;font-size:1rem">${p1.name || 'TBD'}</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">${p1.country || ''} ${p1.ranking ? '(#' + p1.ranking + ')' : ''}</div>
            </div>
            <div style="font-size:1.2rem;font-weight:bold;color:var(--accent)">VS</div>
            <div style="text-align:center;flex:1">
                <div style="font-weight:700;font-size:1rem">${p2.name || 'TBD'}</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">${p2.country || ''} ${p2.ranking ? '(#' + p2.ranking + ')' : ''}</div>
            </div>
        </div>
        ${m.score ? `<div style="text-align:center;font-size:1.3rem;font-weight:bold;color:var(--accent);margin-bottom:12px">${m.score}</div>` : ''}
        ${cs != null ? `<div style="text-align:center;margin-bottom:12px"><span class="confidence ${cc}">${confLabel(cs)} ${cs}/100</span></div>` : ''}
        <div style="background:var(--bg);padding:12px;border-radius:8px;font-size:0.8rem">
            <p><strong>Estado:</strong> ${statusLabel(m.status)}</p>
            ${m.best_of ? `<p><strong>Formato:</strong> Melhor de ${m.best_of}</p>` : ''}
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}

function showStats(s) {
    document.getElementById('stats-panel').innerHTML = `
        <div class="stat"><div class="stat-value">${s.todayGames}</div><div class="stat-label">Hoje</div></div>
        <div class="stat"><div class="stat-value">${s.live}</div><div class="stat-label">Live</div></div>
        <div class="stat"><div class="stat-value">${s.completed}</div><div class="stat-label">Terminados</div></div>
        <div class="stat"><div class="stat-value">${s.total}</div><div class="stat-label">Total Jogos</div></div>
        <div class="stat"><div class="stat-value">${s.withPredictions}</div><div class="stat-label">Previsões</div></div>
        <div class="stat"><div class="stat-value">${s.correct}</div><div class="stat-label">Corretas</div></div>
    `;
}

function loader(show) { document.getElementById('loader').classList.toggle('active', show); }
function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('active');
    setTimeout(() => t.classList.remove('active'), 4000);
}

async function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');

    if (!cachedData[tab]) {
        loader(true);
        try {
            if (tab === 'today') cachedData[tab] = await loadToday();
            else if (tab === 'upcoming') cachedData[tab] = await loadUpcoming();
            else if (tab === 'results') cachedData[tab] = await loadResults();
            else if (tab === 'predictions') cachedData[tab] = await loadPredictions();
            else if (tab === 'stats') { await loadStats(); return; }
        } catch (e) {
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
    }

    if (tab === 'stats') {
        loader(true);
        try { const s = await loadStats(); showStats(s); }
        catch (e) { toast('Erro: ' + e.message); }
        finally { loader(false); }
    } else {
        renderFiltered();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    document.querySelectorAll('.filter').forEach(f => f.addEventListener('click', () => {
        document.querySelectorAll('.filter').forEach(x => x.classList.remove('active'));
        f.classList.add('active');
        currentFilter = f.dataset.filter;
        renderFiltered();
    }));
    document.querySelector('.modal-close').addEventListener('click', () => document.getElementById('modal').classList.remove('active'));
    document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') e.target.classList.remove('active'); });

    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        deferredPrompt = e;
        const btn = document.getElementById('install-btn');
        btn.style.display = 'flex';
        btn.onclick = () => { deferredPrompt.prompt(); deferredPrompt = null; btn.style.display = 'none'; };
    });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

    switchTab('today');
});
