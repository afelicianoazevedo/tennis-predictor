const SUPABASE_URL = 'https://ywmrxvurnxgnmpcjnisi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0';

let currentTab = 'matches';
let currentFilter = 'all';
let cachedData = {};
let matchesPollInterval = null;
let settings = { theme: 'dark', oddsFilter: 'all', predictionFilter: 'all' };
let selectedDate = getLocalYMD(new Date());
let resultsFilter = 'all';
let resultsDate = getLocalYMD(new Date());
let resultsData = {};
let resultsPollInterval = null;
let currentStatsPeriod = 'day';

function log(msg) {
    console.log('[TennisPred]', msg);
}

async function api(table, opts = {}) {
    const { select = '*', eq = {}, gte = {}, lte = {}, order = 'scheduled_at.asc', limit = 100, or = '' } = opts;
    const p = new URLSearchParams({ select, order, limit: limit.toString() });
    Object.entries(eq).forEach(([k, v]) => p.set(k, `eq.${v}`));
    Object.entries(gte).forEach(([k, v]) => p.set(k, `gte.${v}`));
    Object.entries(lte).forEach(([k, v]) => p.set(k, `lte.${v}`));
    if (or) p.set('or', or);

    const url = `${SUPABASE_URL}/rest/v1/${table}?${p}`;
    log('Fetching: ' + url);

    const res = await fetch(url, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
    }
    return res.json();
}

const PLAYER_SELECT = 'player1:players!matches_player1_id_fkey(id,name,country,ranking,gender,elo_rating),player2:players!matches_player2_id_fkey(id,name,country,ranking,gender,elo_rating)';
const TOUR_SELECT = 'tournament:tournaments(name)';
const NAME_SELECT = 'player1_name,player2_name,tournament_name,category';

async function loadToday() {
    const today = new Date().toISOString().split('T')[0];
    const data = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,sets,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
        eq: { status: 'upcoming' }, order: 'scheduled_at.asc', limit: 500
    });
    return (data || []).filter(m => {
        const matchDate = m.scheduled_at ? m.scheduled_at.split('T')[0] : '';
        return matchDate === today;
    });
}

async function loadUpcoming() {
    const tomorrow = new Date(Date.now() + 864e5).toISOString().split('T')[0];
    const max = new Date(Date.now() + 3 * 864e5).toISOString().split('T')[0];
    const data = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,sets,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
        eq: { status: 'upcoming' }, order: 'scheduled_at.asc', limit: 500
    });
    return (data || []).filter(m => {
        const matchDate = m.scheduled_at ? m.scheduled_at.split('T')[0] : '';
        return matchDate >= tomorrow && matchDate <= max;
    });
}

async function loadResults() {
    const week = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0];
    const data = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,sets,winner_id,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
        eq: { status: 'completed' }, order: 'scheduled_at.desc', limit: 500
    });
    return (data || []).filter(m => m.score && m.score !== '0-0' && m.scheduled_at && m.scheduled_at.split('T')[0] >= week);
}

function filterPrediction(matches, filter) {
    const isDoubles = (m) => {
        const p1 = m.player1?.name || '';
        const p2 = m.player2?.name || '';
        return p1.includes('/') || p2.includes('/');
    };
    if (filter === 'with-prediction') {
        return matches.filter(m => m.confidence_score != null && !isDoubles(m));
    }
    if (filter === 'without-prediction') {
        return matches.filter(m => m.confidence_score == null || isDoubles(m));
    }
    return matches;
}

async function loadAllMatches(date) {
    const d = date || selectedDate;
    const today = getLocalYMD(new Date());
    const isPast = d < today;

    let upcoming = [];
    let completed = [];
    let live = [];

    if (!isPast) {
        upcoming = await api('matches', {
            select: `id,scheduled_at,status,round,surface,score,sets,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
            eq: { status: 'upcoming' }, order: 'scheduled_at.asc', limit: 500
        });
    }

    completed = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,sets,winner_id,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
        eq: { status: 'completed' }, order: 'scheduled_at.desc', limit: 500
    });

    live = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,sets,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
        eq: { status: 'live' }, order: 'scheduled_at.asc', limit: 500
    });

    const all = [...(upcoming || []), ...(live || [])];
    log(`loadAllMatches(${d}): upcoming=${upcoming?.length || 0}, completed=${completed?.length || 0}, live=${live?.length || 0}, total=${all.length}`);

    return all.filter(m => {
        const matchDate = m.scheduled_at ? m.scheduled_at.split('T')[0] : '';
        if (matchDate !== d) return false;
        if (m.status !== 'completed' && m.confidence_score === 50) return false;
        return true;
    });
}

async function loadResults(date) {
    const d = date || resultsDate;
    const data = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,sets,winner_id,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT},${NAME_SELECT}`,
        eq: { status: 'completed' }, order: 'scheduled_at.desc', limit: 500
    });
    return (data || []).filter(m => {
        const matchDate = m.scheduled_at ? m.scheduled_at.split('T')[0] : '';
        return matchDate === d;
    });
}

async function cleanupOrphanMatches() {
    const today = getLocalYMD(new Date());
    try {
        const allUpcoming = await api('matches', {
            select: 'id,scheduled_at',
            eq: { status: 'upcoming' }, order: 'scheduled_at.asc', limit: 1000
        });

        const orphans = (allUpcoming || []).filter(m => {
            const matchDate = m.scheduled_at ? m.scheduled_at.split('T')[0] : '';
            return matchDate < today;
        });

        if (!orphans || orphans.length === 0) return;

        const ids = orphans.map(m => m.id).filter(Boolean);
        if (ids.length === 0) return;

        await fetch(`${SUPABASE_URL}/rest/v1/matches?id=in.(${ids.join(',')})`, {
            method: 'DELETE',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        log(`Cleaned up ${ids.length} orphan upcoming matches from past dates`);
    } catch (e) {
        console.error('Cleanup failed:', e);
    }
}

async function loadStats(period = 'day', gameType = 'all') {
    let start = null;
    let end = null;
    const now = new Date();

    if (period === 'day') {
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const tomorrowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        start = todayUTC.toISOString();
        end = tomorrowUTC.toISOString();
    } else if (period === 'week') {
        const day = now.getUTCDay();
        const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff));
        start = weekStart.toISOString();
    } else if (period === 'month') {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        start = monthStart.toISOString();
    } else if (period === 'year') {
        const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
        start = yearStart.toISOString();
    }

    const matches = await api('matches', {
        select: 'id,status,scheduled_at,category,predicted_winner_id,winner_id',
        order: 'scheduled_at.desc',
        ...(start ? { gte: { scheduled_at: start } } : {}),
        ...(end ? { lte: { scheduled_at: end } } : {})
    });

    const filteredMatches = filterMatches(matches, gameType);
    const total = filteredMatches.length;
    const completed = filteredMatches.filter(m => m.status === 'completed').length;

    const withPredictions = filteredMatches.filter(m => m.predicted_winner_id && m.winner_id).length;
    const verified = filteredMatches.filter(m => m.predicted_winner_id && m.winner_id);
    const correct = verified.filter(m => m.predicted_winner_id === m.winner_id).length;
    const wrong = verified.filter(m => m.predicted_winner_id !== m.winner_id).length;
    const accuracy = withPredictions > 0 ? Math.round((correct / withPredictions) * 100) : 0;

    return { total: filteredMatches.length, completed: filteredMatches.filter(m => m.status === 'completed').length, withPredictions, correct, wrong, accuracy, verified: correct + wrong };
}

function time(d) {
    if (!d) return '--:--';
    return new Date(d).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

function date(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
}

function dateShort(d) {
    if (!d) return '';
    const dt = new Date(d);
    const day = String(dt.getDate()).padStart(2, '0');
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}`;
}

function getSetCount(m) {
    if (!m.sets) return null;
    try {
        const sets = Array.isArray(m.sets) ? m.sets : JSON.parse(m.sets);
        if (!Array.isArray(sets) || sets.length < 2) return null;
        const p1Sets = sets[0];
        const p2Sets = sets[1];
        if (typeof p1Sets !== 'number' || typeof p2Sets !== 'number') return null;
        return `${p1Sets}-${p2Sets}`;
    } catch (e) {
        return null;
    }
}

function parseSets(m) {
    if (!m.sets) return [];
    try {
        const raw = Array.isArray(m.sets) ? m.sets : JSON.parse(m.sets);
        if (!Array.isArray(raw) || raw.length < 2) return [];
        const p1Sets = raw[0];
        const p2Sets = raw[1];
        if (typeof p1Sets !== 'number' || typeof p2Sets !== 'number') return [];
        const sets = [];
        for (let i = 0; i < p1Sets + p2Sets; i++) {
            sets.push([0, 0]);
        }
        return sets;
    } catch (e) {
        return [];
    }
}

function confClass(prob, confidenceScore) {
    if (prob == null && confidenceScore == null) return '';
    const value = prob != null ? prob : confidenceScore;
    if (value >= 50 && value <= 60) return 'uncertain';
    if (value > 60 && value <= 75) return 'dangerous';
    if (value > 75 && value <= 90) return 'tendency';
    if (value > 90 && value <= 100) return 'strong';
    if (value < 50) return 'uncertain';
    return 'uncertain';
}

function confLabel(s) {
    if (s == null) return '';
    if (s >= 50 && s <= 60) return 'INCERTO';
    if (s > 60 && s <= 75) return 'ARRISCADO';
    if (s > 75 && s <= 90) return 'TENDÊNCIA';
    if (s > 90 && s <= 100) return 'FORTE';
    if (s < 50) return 'INCERTO';
    return 'INCERTO';
}

function applyTheme(theme) {
    if (theme === 'light') {
        document.documentElement.style.setProperty('--bg', '#f8fafc');
        document.documentElement.style.setProperty('--bg-card', '#ffffff');
        document.documentElement.style.setProperty('--bg-hover', '#f1f5f9');
        document.documentElement.style.setProperty('--text', '#0f172a');
        document.documentElement.style.setProperty('--text-dim', '#64748b');
        document.documentElement.style.setProperty('--border', '#e2e8f0');
    } else {
        document.documentElement.style.setProperty('--bg', '#0f172a');
        document.documentElement.style.setProperty('--bg-card', '#1e293b');
        document.documentElement.style.setProperty('--bg-hover', '#334155');
        document.documentElement.style.setProperty('--text', '#f1f5f9');
        document.documentElement.style.setProperty('--text-dim', '#94a3b8');
        document.documentElement.style.setProperty('--border', '#334155');
    }
}

function getLocalYMD(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + delta);
    return getLocalYMD(date);
}

function formatDateEU(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function parseDateEU(str) {
    if (!str) return null;
    const parts = str.split('/');
    if (parts.length !== 3) return null;
    const [d, m, y] = parts.map(Number);
    if (!d || !m || !y) return null;
    const date = new Date(y, m - 1, d);
    return getLocalYMD(date);
}

function syncDateInput() {
    const input = document.getElementById('date-input');
    if (input) input.value = selectedDate;
}

async function applyDate(newDate) {
    const parsed = typeof newDate === 'string' && newDate.includes('/') ? parseDateEU(newDate) : newDate;
    if (!parsed) {
        log('Invalid date format: ' + newDate);
        return;
    }
    selectedDate = parsed;
    syncDateInput();
    log('Date changed to: ' + selectedDate);
    
    if (currentTab === 'matches') {
        loader(true);
        try {
            cachedData[currentTab] = await loadAllMatches(selectedDate);
            log('Loaded ' + (cachedData[currentTab]?.length || 0) + ' matches for ' + selectedDate);
        } catch (e) {
            log('ERROR loading matches: ' + e.message);
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
        renderFiltered();
    }
}

async function changeDate(delta) {
    const newDate = addDays(selectedDate, delta);
    await applyDate(newDate);
}

async function changeResultsDate(delta) {
    const newDate = addDays(resultsDate, delta);
    await applyResultsDate(newDate);
}

function syncResultsDateInput() {
    const input = document.getElementById('results-date-input');
    if (input) input.value = resultsDate;
}

async function applyResultsDate(newDate) {
    const parsed = typeof newDate === 'string' && newDate.includes('/') ? parseDateEU(newDate) : newDate;
    if (!parsed) {
        log('Invalid date format: ' + newDate);
        return;
    }
    resultsDate = parsed;
    syncResultsDateInput();
    log('Results date changed to: ' + resultsDate);
    
    if (currentTab === 'results') {
        loader(true);
        try {
            resultsData['results'] = await loadResults(resultsDate);
            log('Loaded ' + (resultsData['results']?.length || 0) + ' results for ' + resultsDate);
        } catch (e) {
            log('ERROR loading results: ' + e.message);
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
        renderResultsFiltered();
    }
}

function renderResultsFiltered() {
    const data = resultsData['results'] || [];
    const genderFiltered = filterMatches(data, resultsFilter);
    renderMatches(genderFiltered, 'results-list');
}

function statusLabel(s) {
    return { upcoming: 'Agendado', live: 'LIVE', completed: 'Terminado', cancelled: 'Cancelado' }[s] || s;
}

function filterMatches(matches, cat) {
    if (cat === 'all') return matches;
    return matches.filter(m => {
        const category = m.category || (() => {
            const p1 = m.player1?.name || '';
            const p2 = m.player2?.name || '';
            if (p1.includes('/') || p2.includes('/')) return 'D';
            return m.player1?.gender === 'F' ? 'W' : 'M';
        })();
        if (cat === 'doubles') return category === 'D';
        if (cat === 'men') return category === 'M';
        if (cat === 'women') return category === 'W';
        return true;
    });
}

function filterOdds(matches, mode) {
    if (mode === 'all') return matches;
    return matches.filter(m => m.player1_probability != null && m.player2_probability != null);
}

function renderMatch(m) {
    const p1 = m.player1 || {};
    const p2 = m.player2 || {};
    const tour = m.tournament || {};
    const cs = m.confidence_score;
    const p1Prob = m.player1_probability;
    const p2Prob = m.player2_probability;
    const cc = confClass(p1Prob || p2Prob, cs);
    const predId = m.predicted_winner_id;
    let p1Fav = predId && p1.id === predId;
    let p2Fav = predId && p2.id === predId;

    if (p1Prob != null && p2Prob != null && Math.abs(p1Prob - p2Prob) <= 0.01) {
        p1Fav = false;
        p2Fav = false;
    } else if (!predId && p1Prob != null && p2Prob != null) {
        if (p1Prob > p2Prob) p1Fav = true;
        else if (p2Prob > p1Prob) p2Fav = true;
    }
    const isCompleted = m.status === 'completed';
    const isLive = m.status === 'live';

    const wasCorrect = isCompleted && predId && m.winner_id ? (predId === m.winner_id) : null;
    const p1Display = p1Prob != null ? p1Prob.toFixed(1) : null;
    const p2Display = p2Prob != null ? p2Prob.toFixed(1) : null;
    const p1Confidence = (p1Fav && p1Prob != null) ? `<span class="confidence ${cc}">${p1Display}%</span>` : (p1Fav && p1Prob == null && cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}%</span>` : '');
    const p2Confidence = (p2Fav && p2Prob != null) ? `<span class="confidence ${cc}">${p2Display}%</span>` : (p2Fav && p2Prob == null && cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}%</span>` : '');
    const setCount = getSetCount(m);
    const p1ResultBadge = (p1Fav && isCompleted && wasCorrect === true) ? '<span class="check">✓</span>' : (p1Fav && isCompleted && wasCorrect === false) ? '<span class="cross">✗</span>' : '';
    const p2ResultBadge = (p2Fav && isCompleted && wasCorrect === true) ? '<span class="check">✓</span>' : (p2Fav && isCompleted && wasCorrect === false) ? '<span class="cross">✗</span>' : '';
    const p1Name = p1.name || m.player1_name || 'TBD';
    const p2Name = p2.name || m.player2_name || 'TBD';
    const p1Info = `${p1.country || ''} ${p1.ranking ? '(#' + p1.ranking + ')' : ''}`;
    const p2Info = `${p2.country || ''} ${p2.ranking ? '(#' + p2.ranking + ')' : ''}`;

    return `
        <div class="match c-${cc} ${isCompleted ? 'is-completed' : ''}" data-id="${m.id}">
            <div class="match-time">
                <span class="match-date-short">${dateShort(m.scheduled_at)}</span>
                <span class="match-time-text">${time(m.scheduled_at)}</span>
                ${isLive ? '<span class="live-dot">●</span>' : ''}
            </div>
            <div class="match-body">
                <div class="match-tour">${m.tournament_name || tour.name || ''} ${m.round ? '• ' + m.round : ''} ${m.surface ? '• ' + m.surface : ''}</div>
                <div class="match-players">
                    <div class="player">
                <div class="player-name">
                    ${p1Name}
                </div>
                        <div class="player-info">${p1Info}${!p1Info && p2Info ? '<span class="player-info invisible">-</span>' : ''}</div>
                        <div class="player-odds" style="font-size:0.7rem;color:#fbbf24;display:none"></div>
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                            ${p1Confidence}${!p1Confidence && (p2Confidence || p1ResultBadge || p2ResultBadge) ? '<span class="confidence invisible">0%</span>' : ''}
                            ${p1ResultBadge}
                        </div>
                    </div>
                    <div class="match-score-vs">${isCompleted && setCount ? setCount : (isCompleted && m.score ? m.score : 'vs')}</div>
                    <div class="player">
                <div class="player-name">
                    ${p2Name}
                </div>
                        <div class="player-info">${p2Info}${!p2Info && p1Info ? '<span class="player-info invisible">-</span>' : ''}</div>
                        <div class="player-odds" style="font-size:0.7rem;color:#fbbf24;display:none"></div>
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                            ${p2Confidence}${!p2Confidence && (p1Confidence || p1ResultBadge || p2ResultBadge) ? '<span class="confidence invisible">0%</span>' : ''}
                            ${p2ResultBadge}
                        </div>
                    </div>
                </div>
                <div class="match-odds" style="font-size:0.7rem;color:var(--text-dim);text-align:center;margin-top:2px;display:none"></div>
            </div>
        </div>
    `;
}

function renderMatches(matches, containerId) {
    const el = document.getElementById(containerId);
    if (!el) {
        log('ERROR: container not found: ' + containerId);
        return;
    }
    const counterId = containerId === 'results-list' ? 'results-counter' : 'match-counter';
    const counter = document.getElementById(counterId);
    if (counter) counter.textContent = matches.length;
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
    
    attachOddsToMatches(matches, el);
}

async function attachOddsToMatches(matches, container) {
    for (const m of matches) {
        const p1 = m.player1 || {};
        const p2 = m.player2 || {};
        const p1Name = p1.name || m.player1_name || 'TBD';
        const p2Name = p2.name || m.player2_name || 'TBD';
        const card = container.querySelector(`.match[data-id="${m.id}"]`);
        if (!card) continue;
        
        const odds = await loadOdds(m.id, p1Name, p2Name);
        if (!odds) continue;
        
        const oddsText = renderOdds(odds);
        const p1OddsEl = card.querySelector('.player:first-child .player-odds');
        const p2OddsEl = card.querySelector('.player:last-child .player-odds');
        if (p1OddsEl) {
            p1OddsEl.textContent = oddsText.p1;
            p1OddsEl.style.display = 'block';
            p1OddsEl.style.color = '#fbbf24';
        }
        if (p2OddsEl) {
            p2OddsEl.textContent = oddsText.p2;
            p2OddsEl.style.display = 'block';
            p2OddsEl.style.color = '#fbbf24';
        }
    }
}

function renderFiltered() {
    const data = cachedData[currentTab] || [];
    const genderFiltered = filterMatches(data, currentFilter);
    const oddsFiltered = filterOdds(genderFiltered, settings.oddsFilter);
    const predictionFiltered = filterPrediction(oddsFiltered, settings.predictionFilter);
    renderMatches(predictionFiltered, 'matches-list');
}

function showModal(m) {
    const p1 = m.player1 || {};
    const p2 = m.player2 || {};
    const tour = m.tournament || {};
    const cs = m.confidence_score;
    const p1Prob = m.player1_probability;
    const p2Prob = m.player2_probability;
    const cc = confClass(p1Prob || p2Prob, cs);
    const predId = m.predicted_winner_id;
    let p1Fav = predId && p1.id === predId;
    let p2Fav = predId && p2.id === predId;

    if (!p1Fav && !p2Fav && predId) {
        if (m.player1_name && predId === m.player1_name) p1Fav = true;
        if (m.player2_name && predId === m.player2_name) p2Fav = true;
    }

    if (p1Prob != null && p2Prob != null && Math.abs(p1Prob - p2Prob) <= 0.01) {
        p1Fav = false;
        p2Fav = false;
    } else if (!predId && p1Prob != null && p2Prob != null) {
        if (p1Prob > p2Prob) p1Fav = true;
        else if (p2Prob > p1Prob) p2Fav = true;
    }

    const p1Name = p1.name || m.player1_name || 'TBD';
    const p2Name = p2.name || m.player2_name || 'TBD';
    const favProb = p1Fav ? p1Prob : (p2Fav ? p2Prob : null);
    const favLabel = p1Fav ? p1Name : (p2Fav ? p2Name : null);
    const wasCorrect = m.status === 'completed' && predId && m.winner_id ? (predId === m.winner_id) : null;
    const showResult = m.status === 'completed' && m.score;

    const setCount = getSetCount(m);
    const setsInfo = m.status === 'completed' && setCount ? `<div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px">Sets: ${setCount}</div>` : '';

    document.getElementById('modal-content').innerHTML = `
        <h3>${m.tournament_name || tour.name || 'Jogo'}</h3>
        <p style="color:var(--text-dim);margin:8px 0 16px">${date(m.scheduled_at)} ${time(m.scheduled_at)} ${m.round ? '• ' + m.round : ''} ${m.surface ? '• ' + m.surface : ''}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px">
            <div style="text-align:center;flex:1;display:flex;flex-direction:column;gap:4px">
                <div style="font-weight:700;font-size:1rem;min-height:2.4em;line-height:1.2">${p1Name}</div>
                <div style="font-size:0.75rem;color:var(--text-dim);min-height:1.2em">${p1.country || ''} ${p1.ranking ? '(#' + p1.ranking + ')' : ''} ${p1.elo_rating && p1.elo_rating !== 1500 ? '(ELO ' + Math.round(p1.elo_rating) + ')' : ''}</div>
                <div id="modal-odds-p1" style="font-size:0.7rem;color:#fbbf24;min-height:1.2em"></div>
                ${p1Fav && p1Prob != null ? `<span class="confidence ${cc}">${p1Prob.toFixed(1)}%</span>` : '<span class="confidence" style="visibility:hidden">0%</span>'}
                ${p1Fav && cs != null ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">Confiança: ${cs.toFixed(0)}%</div>` : '<div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px;visibility:hidden">Confiança: 0%</div>'}
            </div>
            <div style="text-align:center">
                <div style="font-size:1.2rem;font-weight:bold;color:var(--accent)">${showResult ? m.score : 'VS'}</div>
                ${setsInfo}
            </div>
            <div style="text-align:center;flex:1;display:flex;flex-direction:column;gap:4px">
                <div style="font-weight:700;font-size:1rem;min-height:2.4em;line-height:1.2">${p2Name}</div>
                <div style="font-size:0.75rem;color:var(--text-dim);min-height:1.2em">${p2.country || ''} ${p2.ranking ? '(#' + p2.ranking + ')' : ''} ${p2.elo_rating && p2.elo_rating !== 1500 ? '(ELO ' + Math.round(p2.elo_rating) + ')' : ''}</div>
                <div id="modal-odds-p2" style="font-size:0.7rem;color:#fbbf24;min-height:1.2em"></div>
                ${p2Fav && p2Prob != null ? `<span class="confidence ${cc}">${p2Prob.toFixed(1)}%</span>` : '<span class="confidence" style="visibility:hidden">0%</span>'}
                ${p2Fav && cs != null ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">Confiança: ${cs.toFixed(0)}%</div>` : '<div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px;visibility:hidden">Confiança: 0%</div>'}
            </div>
        </div>
        ${(p1Fav || p2Fav) && p1Prob != null && p2Prob != null ? `<div style="text-align:center;font-size:0.8rem;color:var(--text-dim);margin-bottom:12px">Probabilidade: <strong>${p1Prob.toFixed(1)}%</strong> vs <strong>${p2Prob.toFixed(1)}%</strong></div>` : ''}
        <div style="background:var(--bg);padding:12px;border-radius:8px;margin-bottom:12px;text-align:center">
            <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">Previsão</div>
            <div style="font-weight:700;font-size:0.95rem">${favLabel || (p1Prob > p2Prob ? p1Name : p2Name)}</div>
            <div style="margin-top:6px">
                ${favProb != null ? `<span class="confidence ${cc}">${favProb.toFixed(1)}%</span>` : ''}
                ${cs != null ? `<span style="font-size:0.7rem;color:var(--text-dim);margin-left:6px">${confLabel(cs)} ${cs.toFixed(0)}%</span>` : ''}
            </div>
            ${showResult && wasCorrect != null ? `<div style="margin-top:6px;font-size:0.8rem;color:${wasCorrect ? '#22c55e' : '#ef4444'};font-weight:600">${wasCorrect ? '✓ Previsão correta' : '✗ Previsão incorreta'}</div>` : ''}
        </div>
        <div id="modal-h2h" style="text-align:center;font-size:0.8rem;color:var(--text-dim);margin-bottom:12px"></div>
        <div id="modal-factors" style="text-align:center;font-size:0.8rem;color:var(--text-dim);margin-bottom:12px">
            <div class="factors-loading">A carregar fatores de previsão e odds...</div>
        </div>
        <div style="background:var(--bg);padding:12px;border-radius:8px;font-size:0.8rem">
            <p><strong>Estado:</strong> ${statusLabel(m.status)}</p>
            ${m.best_of ? `<p><strong>Formato:</strong> Melhor de ${m.best_of}</p>` : ''}
        </div>
    `;
    document.getElementById('modal').classList.add('active');

    if (p1.id && p2.id) {
        loadH2H(p1.id, p2.id);
    }
    
    if (m.id) {
        Promise.all([
            loadPredictionFactors(m.id),
            loadOdds(m.id, p1Name, p2Name)
        ]).then(([factors, odds]) => {
            const factorsEl = document.getElementById('modal-factors');
            if (factorsEl) {
                factorsEl.outerHTML = renderPredictionFactors(factors, p1Name, p2Name, odds, p1, p2);
            }
            
            if (odds) {
                const oddsText = renderOdds(odds);
                const oddsP1El = document.getElementById('modal-odds-p1');
                const oddsP2El = document.getElementById('modal-odds-p2');
                if (oddsP1El) oddsP1El.textContent = oddsText.p1;
                if (oddsP2El) oddsP2El.textContent = oddsText.p2;
            }
        }).catch(err => {
            console.error('Error loading prediction data:', err);
            const factorsEl = document.getElementById('modal-factors');
            if (factorsEl) {
                factorsEl.outerHTML = `<div class="factors-loading">Erro ao carregar fatores: ${err.message}</div>`;
            }
        });
    }
}

function showStats(s) {
    const el = document.getElementById('stats-panel');
    const accuracy = s.withPredictions > 0 ? Math.round((s.correct / s.withPredictions) * 100) : 0;
    const wrongPct = s.withPredictions > 0 ? Math.round((s.wrong / s.withPredictions) * 100) : 0;

    el.innerHTML = `
        <div class="stats-summary">
            <div class="stat"><div class="stat-value">${s.completed}</div><div class="stat-label">Terminados</div></div>
            <div class="stat"><div class="stat-value">${s.verified}</div><div class="stat-label">Com Resultado</div></div>
        </div>
        <div class="chart-container">
            <canvas id="accuracy-chart"></canvas>
        </div>
    `;

    renderAccuracyChart(s.correct, s.wrong, accuracy, wrongPct);

    document.querySelectorAll('.stats-filters .period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === currentStatsPeriod);
    });
}

function renderAccuracyChart(correct, wrong, accuracy, wrongPct) {
    const ctx = document.getElementById('accuracy-chart');
    if (!ctx) return;

    if (window.accuracyChartInstance) {
        window.accuracyChartInstance.destroy();
    }

    window.accuracyChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Acertos', 'Falhas'],
            datasets: [{
                label: 'Previsões',
                data: [correct, wrong],
                backgroundColor: ['#22c55e', '#ef4444'],
                borderRadius: 8,
                barThickness: 60
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const total = correct + wrong;
                            const pct = total > 0 ? Math.round((context.raw / total) * 100) : 0;
                            return `${context.raw} (${pct}%)`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, color: '#94a3b8' },
                    grid: { color: '#334155' }
                },
                x: {
                    ticks: { color: '#f1f5f9' },
                    grid: { display: false }
                }
            }
        },
        layout: {
            padding: {
                top: 20
            }
        },
        plugins: [{
            id: 'percentageOnTop',
            afterDatasetsDraw: function(chart) {
                const ctx = chart.ctx;
                const meta0 = chart.getDatasetMeta(0);
                const total = correct + wrong;
                ctx.save();
                ctx.font = 'bold 14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#fff';
                meta0.data.forEach((bar, index) => {
                    const value = chart.data.datasets[0].data[index];
                    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
                    const textY = Math.max(bar.y - 8, 10);
                    ctx.fillText(`${pct}%`, bar.x, textY);
                });
                ctx.restore();
            }
        }]
    });
}

function loader(show) {
    const el = document.getElementById('loader');
    if (el) el.classList.toggle('active', show);
}

async function loadH2H(id1, id2) {
    try {
        const [r1, r2] = await Promise.all([
            api('matches', {
                select: 'winner_id',
                eq: { player1_id: id1, player2_id: id2, status: 'completed' },
                limit: 50
            }),
            api('matches', {
                select: 'winner_id',
                eq: { player1_id: id2, player2_id: id1, status: 'completed' },
                limit: 50
            })
        ]);

        const all = [...(r1 || []), ...(r2 || [])];
        const p1Wins = all.filter(m => m.winner_id === id1).length;
        const p2Wins = all.filter(m => m.winner_id === id2).length;

        const el = document.getElementById('modal-h2h');
        if (el && (p1Wins > 0 || p2Wins > 0)) {
            el.textContent = `H2H: ${p1Wins}-${p2Wins}`;
        } else if (el) {
            el.textContent = 'H2H: Sem jogos anteriores';
        }
    } catch (e) {
        console.error('Error loading H2H:', e);
    }
}

async function loadPredictionFactors(matchId) {
    try {
        const factors = await api('match_prediction_factors', {
            select: '*',
            eq: { match_id: matchId }
        });
        return factors[0] || null;
    } catch (e) {
        console.error('Error loading prediction factors:', e);
        return null;
    }
}

function renderFactorBar(label, p1Score, p2Score, p1Name, p2Name) {
    if (p1Score === null && p2Score === null) return '';
    
    const p1 = p1Score !== null ? (p1Score > p2Score ? Math.ceil(p1Score) : Math.floor(p1Score)) : 50;
    const p2 = p2Score !== null ? (p2Score > p1Score ? Math.ceil(p2Score) : Math.floor(p2Score)) : 50;
    const total = p1 + p2;
    const p1Width = total > 0 ? (p1 / total) * 100 : 50;
    const p2Width = total > 0 ? (p2 / total) * 100 : 50;
    
    const showP1Val = p1Score !== null;
    const showP2Val = p2Score !== null;
    
    return `
        <div class="factor-row">
            <div class="factor-label">${label}</div>
            <div style="flex:1">
                <div class="factor-bar-container">
                    <div class="factor-bar-p1" style="width:${p1Width}%">
                        ${showP1Val ? `<span>${p1}</span>` : ''}
                    </div>
                    <div class="factor-bar-p2" style="width:${p2Width}%">
                        ${showP2Val ? `<span>${p2}</span>` : ''}
                    </div>
                </div>
                <div class="factor-values">
                    <div class="factor-value-p1">${showP1Val ? p1 : '-'}</div>
                    <div class="factor-value-p2">${showP2Val ? p2 : '-'}</div>
                </div>
            </div>
        </div>
    `;
}

async function loadOdds(matchId, p1Name, p2Name) {
    try {
        let odds = null;
        
        if (matchId) {
            odds = await api('odds', {
                select: 'player1_odd,player2_odd,market,source,captured_at',
                eq: { match_id: matchId },
                order: 'captured_at.desc',
                limit: 1
            });
        }
        
        if (!odds || odds.length === 0) {
            const orFilter = `(player1_name.eq.${p1Name},player2_name.eq.${p1Name},player1_name.eq.${p2Name},player2_name.eq.${p2Name})`;
            odds = await api('odds', {
                select: 'player1_odd,player2_odd,market,source,captured_at',
                or: orFilter,
                order: 'captured_at.desc',
                limit: 1
            });
        }
        
        return odds[0] || null;
    } catch (e) {
        console.error('Error loading odds:', e);
        return null;
    }
}

function renderOdds(odds) {
    if (!odds || !odds.player1_odd || !odds.player2_odd) return '';
    const p1Odd = Number(odds.player1_odd).toFixed(2);
    const p2Odd = Number(odds.player2_odd).toFixed(2);
    const p1Prob = Number((1 / odds.player1_odd) * 100).toFixed(1);
    const p2Prob = Number((1 / odds.player2_odd) * 100).toFixed(1);
    return {
        p1: `Odd: ${p1Odd} (${p1Prob}%)`,
        p2: `Odd: ${p2Odd} (${p2Prob}%)`,
        combined: `${p1Prob}% / ${p2Prob}%`
    };
}

function renderPredictionFactors(factors, p1Name, p2Name, odds, p1, p2) {
    const factorsHtml = factors ? [
        ['Força', factors.player1_strength_score, factors.player2_strength_score],
        ['Forma', factors.player1_form_score, factors.player2_form_score],
        ['Superfície', factors.player1_surface_score, factors.player2_surface_score],
        ['Serve', factors.player1_serve_score, factors.player2_serve_score],
        ['Return', factors.player1_return_score, factors.player2_return_score],
        ['H2H', factors.player1_h2h_score, factors.player2_h2h_score],
        ['Mercado', factors.player1_market_score, factors.player2_market_score],
        ['Contexto', factors.player1_context_score, factors.player2_context_score]
    ].map(([label, p1Score, p2Score]) => renderFactorBar(label, p1Score, p2Score, p1Name, p2Name)).filter(Boolean).join('') : '';
    
    const agreement = factors?.agreement_score !== null ? Math.round(factors.agreement_score) : null;
    const dataQuality = factors?.data_quality_score !== null ? Math.round(factors.data_quality_score) : null;

    let calculationHtml = '';
    if (p1 && p2) {
        const p1Elo = p1.elo_rating || 1500;
        const p2Elo = p2.elo_rating || 1500;
        const p1Ranking = p1.ranking || null;
        const p2Ranking = p2.ranking || null;

        const eloDiff = p1Elo - p2Elo;
        const p1EloProb = 1 / (1 + Math.pow(10, -eloDiff / 400));
        const p2EloProb = 1 - p1EloProb;

        let p1RankProb = null;
        let p2RankProb = null;
        if (p1Ranking && p2Ranking) {
            p1RankProb = (1 / p1Ranking) / (1 / p1Ranking + 1 / p2Ranking);
            p2RankProb = 1 - p1RankProb;
        }

        let p1OddsProb = null;
        let p2OddsProb = null;
        if (odds && odds.player1_odd && odds.player2_odd) {
            p1OddsProb = (1 / odds.player1_odd) / (1 / odds.player1_odd + 1 / odds.player2_odd);
            p2OddsProb = 1 - p1OddsProb;
        }

        let p1FinalProb, p2FinalProb;
        if (p1OddsProb !== null) {
            p1FinalProb = 0.5 * p1EloProb + 0.3 * (p1RankProb || p1EloProb) + 0.2 * p1OddsProb;
            p2FinalProb = 0.5 * p2EloProb + 0.3 * (p2RankProb || p2EloProb) + 0.2 * p2OddsProb;
        } else {
            p1FinalProb = 0.6 * p1EloProb + 0.4 * (p1RankProb || p1EloProb);
            p2FinalProb = 0.6 * p2EloProb + 0.4 * (p2RankProb || p2EloProb);
        }

        const p1FinalPct = (p1FinalProb * 100).toFixed(1);
        const p2FinalPct = (p2FinalProb * 100).toFixed(1);

        calculationHtml = `
            <div class="factors-section">
                <div class="factors-title">🧮 Cálculo da Previsão</div>
                <div class="factors-summary">
                    <div class="factors-summary-row">
                        <span class="factors-summary-label">ELO (50%)</span>
                        <span class="factors-summary-value">${p1Name}: ${(p1EloProb * 100).toFixed(1)}% | ${p2Name}: ${(p2EloProb * 100).toFixed(1)}%</span>
                    </div>
                    ${p1RankProb !== null ? `
                        <div class="factors-summary-row">
                            <span class="factors-summary-label">Ranking (30%)</span>
                            <span class="factors-summary-value">${p1Name}: ${(p1RankProb * 100).toFixed(1)}% | ${p2Name}: ${(p2RankProb * 100).toFixed(1)}%</span>
                        </div>
                    ` : ''}
                    ${p1OddsProb !== null ? `
                        <div class="factors-summary-row">
                            <span class="factors-summary-label">Odds (20%)</span>
                            <span class="factors-summary-value">${p1Name}: ${(p1OddsProb * 100).toFixed(1)}% | ${p2Name}: ${(p2OddsProb * 100).toFixed(1)}%</span>
                        </div>
                    ` : ''}
                    <div class="factors-summary-row" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
                        <span class="factors-summary-label" style="font-weight:700">Final</span>
                        <span class="factors-summary-value" style="font-weight:700">${p1Name}: ${p1FinalPct}% | ${p2Name}: ${p2FinalPct}%</span>
                    </div>
                </div>
            </div>
        `;
    }

    if (!factors && !calculationHtml) {
        return `<div class="factors-loading">A carregar fatores de previsão...</div>`;
    }

    return `
        <div class="factors-section">
            <div class="factors-title">📊 Fatores de Previsão</div>
            ${factorsHtml}
            <div class="factors-summary">
                ${agreement !== null ? `
                    <div class="factors-summary-row">
                        <span class="factors-summary-label">Acordo</span>
                        <span class="factors-summary-value">${agreement}%</span>
                    </div>
                ` : ''}
                ${dataQuality !== null ? `
                    <div class="factors-summary-row">
                        <span class="factors-summary-label">Qualidade</span>
                        <span class="factors-summary-value">${dataQuality}%</span>
                    </div>
                ` : ''}
            </div>
        </div>
        ${calculationHtml}
    `;
}

let previousMatchStatuses = {};
let lastNotificationTime = 0;

function toast(msg, type = 'info') {
    const t = document.getElementById('toast');
    if (t) {
        t.textContent = msg;
        t.className = 'toast ' + type;
        t.classList.add('active');
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => t.classList.remove('active'), 4000);
    }
}

function detectStatusChanges(matches) {
    const now = Date.now();
    if (now - lastNotificationTime < 5000) return;
    
    let finishedCount = 0;
    let newUpcomingCount = 0;
    const finishedMatches = [];
    
    for (const m of matches) {
        const prev = previousMatchStatuses[m.id];
        if (!prev) {
            if (m.status === 'upcoming') newUpcomingCount++;
            previousMatchStatuses[m.id] = m.status;
            continue;
        }
        
        if (prev === 'live' && m.status === 'completed') {
            finishedCount++;
            finishedMatches.push(m);
        }
        previousMatchStatuses[m.id] = m.status;
    }
    
    if (finishedCount > 0) {
        lastNotificationTime = now;
        const p1 = finishedMatches[0].player1?.name || finishedMatches[0].player1_name || 'Jogador 1';
        const p2 = finishedMatches[0].player2?.name || finishedMatches[0].player2_name || 'Jogador 2';
        if (finishedCount === 1) {
            toast(`Jogo terminado: ${p1} vs ${p2}`, 'success');
        } else {
            toast(`${finishedCount} jogos terminados`, 'success');
        }
    }
    
    if (newUpcomingCount > 0 && currentTab === 'matches') {
        lastNotificationTime = now;
        toast(`${newUpcomingCount} novos jogos upcoming`, 'info');
    }
}

async function switchTab(tab) {
    log('Switching to tab: ' + tab);
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.add('active');

    if (matchesPollInterval) {
        clearInterval(matchesPollInterval);
        matchesPollInterval = null;
    }

    if (resultsPollInterval) {
        clearInterval(resultsPollInterval);
        resultsPollInterval = null;
    }

    if (tab === 'stats') {
        loader(true);
        try {
            const s = await loadStats(currentStatsPeriod);
            showStats(s);
        } catch (e) {
            log('ERROR loading stats: ' + e.message);
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
        return;
    }

    if (tab === 'matches') {
        syncDateInput();
        log('Loading matches for date: ' + selectedDate);
        await cleanupOrphanMatches();
        loader(true);
        try {
            cachedData[tab] = await loadAllMatches(selectedDate);
            detectStatusChanges(cachedData[tab]);
            log('Loaded ' + (cachedData[tab]?.length || 0) + ' matches for ' + selectedDate);
        } catch (e) {
            log('ERROR loading matches: ' + e.message);
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
        renderFiltered();

        matchesPollInterval = setInterval(async () => {
            log('Polling matches for date ' + selectedDate + '...');
            try {
                const data = await loadAllMatches(selectedDate);
                cachedData['matches'] = data;
                detectStatusChanges(data);
                if (currentTab === 'matches') {
                    renderFiltered();
                }
            } catch (e) {
                log('Matches poll error: ' + e.message);
            }
        }, 30000);
        return;
    }

    if (tab === 'results') {
        syncResultsDateInput();
        log('Loading results for date: ' + resultsDate);
        loader(true);
        try {
            resultsData[tab] = await loadResults(resultsDate);
            log('Loaded ' + (resultsData[tab]?.length || 0) + ' results for ' + resultsDate);
        } catch (e) {
            log('ERROR loading results: ' + e.message);
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
        renderResultsFiltered();

        resultsPollInterval = setInterval(async () => {
            log('Polling results for date ' + resultsDate + '...');
            try {
                const data = await loadResults(resultsDate);
                resultsData['results'] = data;
                if (currentTab === 'results') {
                    renderResultsFiltered();
                }
            } catch (e) {
                log('Results poll error: ' + e.message);
            }
        }, 30000);
        return;
    }

    if (tab === 'settings' || tab === 'about') {
        return;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    log('DOM loaded, initializing...');

    const savedTheme = localStorage.getItem('tp-theme');
    if (savedTheme) {
        settings.theme = savedTheme;
        document.getElementById('setting-theme').value = savedTheme;
        applyTheme(savedTheme);
    }

    const savedOdds = localStorage.getItem('tp-odds');
    if (savedOdds) {
        settings.oddsFilter = savedOdds;
        document.getElementById('setting-odds-filter').value = savedOdds;
    }

    const savedPrediction = localStorage.getItem('tp-prediction');
    if (savedPrediction) {
        settings.predictionFilter = savedPrediction;
        const el = document.getElementById('setting-prediction-filter');
        if (el) el.value = savedPrediction;
    }

    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => {
            log('Tab clicked: ' + t.dataset.tab);
            switchTab(t.dataset.tab);
        });
    });

    document.getElementById('filter-select').addEventListener('change', e => {
        log('Filter changed: ' + e.target.value);
        currentFilter = e.target.value;
        renderFiltered();
    });

    document.getElementById('date-prev').addEventListener('click', () => changeDate(-1));
    document.getElementById('date-next').addEventListener('click', () => changeDate(1));

    const dateInput = document.getElementById('date-input');
    if (dateInput) {
        dateInput.addEventListener('change', e => {
            const value = e.target.value;
            if (!value) return;
            const [y, m, d] = value.split('-').map(Number);
            if (y && m && d) {
                const date = new Date(y, m - 1, d);
                applyDate(getLocalYMD(date));
            }
        });
    }

    document.getElementById('results-filter-select').addEventListener('change', e => {
        log('Results filter changed: ' + e.target.value);
        resultsFilter = e.target.value;
        renderResultsFiltered();
    });

    document.getElementById('results-date-prev').addEventListener('click', () => changeResultsDate(-1));
    document.getElementById('results-date-next').addEventListener('click', () => changeResultsDate(1));

    const resultsDateInput = document.getElementById('results-date-input');
    if (resultsDateInput) {
        resultsDateInput.addEventListener('change', e => {
            const value = e.target.value;
            if (!value) return;
            const [y, m, d] = value.split('-').map(Number);
            if (y && m && d) {
                const date = new Date(y, m - 1, d);
                applyResultsDate(getLocalYMD(date));
            }
        });
    }

    document.getElementById('setting-theme').addEventListener('change', e => {
        settings.theme = e.target.value;
        localStorage.setItem('tp-theme', settings.theme);
        applyTheme(settings.theme);
    });

    document.getElementById('setting-odds-filter').addEventListener('change', e => {
        settings.oddsFilter = e.target.value;
        localStorage.setItem('tp-odds', settings.oddsFilter);
        renderFiltered();
    });

    const predictionFilterEl = document.getElementById('setting-prediction-filter');
    if (predictionFilterEl) {
        predictionFilterEl.addEventListener('change', e => {
            settings.predictionFilter = e.target.value;
            localStorage.setItem('tp-prediction', settings.predictionFilter);
            renderFiltered();
        });
    }

    let currentStatsGameType = 'all';

    document.querySelectorAll('.stats-filters .period-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.stats-filters .period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentStatsPeriod = btn.dataset.period;
            if (currentTab === 'stats') {
                loader(true);
                try {
                    const s = await loadStats(currentStatsPeriod, currentStatsGameType);
                    showStats(s);
                } catch (e) {
                    toast('Erro: ' + e.message);
                } finally {
                    loader(false);
                }
            }
        });
    });

    const statsFilterEl = document.getElementById('stats-filter-select');
    if (statsFilterEl) {
        statsFilterEl.addEventListener('change', e => {
            currentStatsGameType = e.target.value;
            if (currentTab === 'stats') {
                loader(true);
                loadStats(currentStatsPeriod, currentStatsGameType).then(s => {
                    showStats(s);
                    loader(false);
                }).catch(e => {
                    toast('Erro: ' + e.message);
                    loader(false);
                });
            }
        });
    }

    document.querySelector('.modal-close').addEventListener('click', () => {
        document.getElementById('modal').classList.remove('active');
    });

    document.getElementById('modal').addEventListener('click', e => {
        if (e.target.id === 'modal') e.target.classList.remove('active');
    });

    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        deferredPrompt = e;
        const btn = document.getElementById('install-btn');
        btn.style.display = 'flex';
        btn.onclick = () => { deferredPrompt.prompt(); deferredPrompt = null; btn.style.display = 'none'; };
    });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

    log('Initialization complete, selectedDate=' + selectedDate + ' formatted=' + formatDateEU(selectedDate));
    switchTab('matches');
});
