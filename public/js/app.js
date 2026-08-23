const SUPABASE_URL = 'https://ywmrxvurnxgnmpcjnisi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0';

let currentTab = 'live';
let currentFilter = 'all';
let cachedData = {};
let livePollInterval = null;

function log(msg) {
    console.log('[TennisPred]', msg);
}

async function api(table, opts = {}) {
    const { select = '*', eq = {}, gte = {}, lte = {}, order = 'scheduled_at.asc', limit = 100 } = opts;
    const p = new URLSearchParams({ select, order, limit: limit.toString() });
    Object.entries(eq).forEach(([k, v]) => p.set(k, `eq.${v}`));
    Object.entries(gte).forEach(([k, v]) => p.set(k, `gte.${v}`));
    Object.entries(lte).forEach(([k, v]) => p.set(k, `lte.${v}`));

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

const PLAYER_SELECT = 'player1:players!matches_player1_id_fkey(id,name,country,ranking,gender),player2:players!matches_player2_id_fkey(id,name,country,ranking,gender)';
const TOUR_SELECT = 'tournament:tournaments(name)';

async function loadLive() {
    return api('matches', {
        select: `id,scheduled_at,status,round,surface,score,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT}`,
        eq: { status: 'live' }, order: 'scheduled_at.asc'
    });
}

async function loadToday() {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 864e5).toISOString().split('T')[0];
    // Only show upcoming games for today (not live, not completed)
    return api('matches', {
        select: `id,scheduled_at,status,round,surface,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT}`,
        gte: { scheduled_at: today }, lte: { scheduled_at: tomorrow },
        eq: { status: 'upcoming' }
    });
}

async function loadUpcoming() {
    const tomorrow = new Date(Date.now() + 864e5).toISOString().split('T')[0];
    const max = new Date(Date.now() + 3 * 864e5).toISOString().split('T')[0];
    // Only show future games (not today)
    return api('matches', {
        select: `id,scheduled_at,status,round,surface,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT}`,
        gte: { scheduled_at: tomorrow }, lte: { scheduled_at: max }, limit: 200
    });
}

async function loadResults() {
    const week = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0];
    const data = await api('matches', {
        select: `id,scheduled_at,status,round,surface,score,winner_id,confidence_score,confidence_level,predicted_winner_id,player1_probability,player2_probability,${PLAYER_SELECT},${TOUR_SELECT}`,
        eq: { status: 'completed' }, gte: { scheduled_at: week }, order: 'scheduled_at.desc'
    });
    return data.filter(m => m.score && m.score !== '0-0');
}

async function loadStats(period = 'all') {
    let start = null;
    let end = null;
    const now = new Date();

    if (period === 'day') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    } else if (period === 'yesterday') {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        start = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString();
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (period === 'week') {
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(now);
        weekStart.setDate(diff);
        start = weekStart.toISOString();
    } else if (period === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    } else if (period === 'year') {
        start = new Date(now.getFullYear(), 0, 1).toISOString();
    }

    const predictions = await api('match_predictions', {
        select: 'id,was_correct,created_at,confidence_score',
        ...(start ? { gte: { created_at: start } } : {}),
        ...(end ? { lt: { created_at: end } } : {})
    });

    const matches = await api('matches', {
        select: 'id,status,scheduled_at',
        ...(start ? { gte: { scheduled_at: start } } : {}),
        ...(end ? { lt: { scheduled_at: end } } : {})
    });

    const today = now.toISOString().split('T')[0];
    const todayGames = matches.filter(m => m.scheduled_at?.startsWith(today)).length;
    const live = matches.filter(m => m.status === 'live').length;
    const completed = matches.filter(m => m.status === 'completed').length;

    const withPredictions = predictions.length;
    const correct = predictions.filter(p => p.was_correct === true).length;
    const wrong = predictions.filter(p => p.was_correct === false).length;
    const accuracy = withPredictions > 0 ? Math.round((correct / withPredictions) * 100) : 0;
    const wrongPct = withPredictions > 0 ? Math.round((wrong / withPredictions) * 100) : 0;

    const trendStats = {
        incerto: { total: 0, correct: 0, wrong: 0 },
        perigoso: { total: 0, correct: 0, wrong: 0 },
        tendencia: { total: 0, correct: 0, wrong: 0 },
        forte: { total: 0, correct: 0, wrong: 0 }
    };

    predictions.forEach(p => {
        if (!p.was_correct || !p.confidence_score) return;
        let level = 'incerto';
        if (p.confidence_score >= 50) level = 'perigoso';
        if (p.confidence_score >= 60) level = 'tendencia';
        if (p.confidence_score >= 70) level = 'forte';
        trendStats[level].total++;
        if (p.was_correct === true) trendStats[level].correct++;
        if (p.was_correct === false) trendStats[level].wrong++;
    });

    return { todayGames, live, completed, withPredictions, correct, wrong, accuracy, wrongPct, total: matches.length, trendStats };
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
        const p1 = m.player1?.name || '';
        const p2 = m.player2?.name || '';
        const doubles = p1.includes('/') || p2.includes('/');
        if (cat === 'doubles') return doubles;
        if (cat === 'men') return !doubles && m.player1?.gender === 'M';
        if (cat === 'women') return !doubles && m.player1?.gender === 'F';
        return true;
    });
}

function renderMatch(m) {
    const p1 = m.player1 || {};
    const p2 = m.player2 || {};
    const tour = m.tournament || {};
    const cs = m.confidence_score;
    const cc = confClass(cs);
    const predId = m.predicted_winner_id;
    const p1Fav = predId && p1.id === predId;
    const p2Fav = predId && p2.id === predId;
    const isCompleted = m.status === 'completed';
    const isLive = m.status === 'live';
    const p1Prob = m.player1_probability;
    const p2Prob = m.player2_probability;

    const wasCorrect = isCompleted && predId && m.winner_id ? (predId === m.winner_id) : null;

    return `
        <div class="match c-${cc} ${isLive ? 'is-live' : ''}" data-id="${m.id}">
            <div class="match-time">${time(m.scheduled_at)}${isLive ? '<br><span class="live-dot">●</span>' : ''}</div>
            <div class="match-body">
                <div class="match-tour">${tour.name || ''} ${m.round ? '• ' + m.round : ''} ${m.surface ? '• ' + m.surface : ''}</div>
                <div class="match-players">
                    <div class="player">
                        <div class="player-name">
                            ${p1.name || 'TBD'}
                        </div>
                        <div class="player-info">${p1.country || ''} ${p1.ranking ? '(#' + p1.ranking + ')' : ''}</div>
                        ${p1Fav && p1Prob != null ? `<span class="confidence ${cc}">${p1Prob}%</span>` : ''}
                        ${p1Fav && p1Prob == null && cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}%</span>` : ''}
                        ${p1Fav && isCompleted && wasCorrect === true ? '<span class="check result-icon">✓</span>' : ''}
                        ${p1Fav && isCompleted && wasCorrect === false ? '<span class="cross result-icon">✗</span>' : ''}
                    </div>
                    <div class="match-score-vs">${m.score || 'vs'}</div>
                    <div class="player">
                        <div class="player-name">
                            ${p2.name || 'TBD'}
                        </div>
                        <div class="player-info">${p2.country || ''} ${p2.ranking ? '(#' + p2.ranking + ')' : ''}</div>
                        ${p2Fav && p2Prob != null ? `<span class="confidence ${cc}">${p2Prob}%</span>` : ''}
                        ${p2Fav && p2Prob == null && cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}%</span>` : ''}
                        ${p2Fav && isCompleted && wasCorrect === true ? '<span class="check result-icon">✓</span>' : ''}
                        ${p2Fav && isCompleted && wasCorrect === false ? '<span class="cross result-icon">✗</span>' : ''}
                    </div>
                </div>
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
    const p1 = m.player1 || {};
    const p2 = m.player2 || {};
    const tour = m.tournament || {};
    const cs = m.confidence_score;
    const cc = confClass(cs);
    const predId = m.predicted_winner_id;
    const p1Fav = predId && p1.id === predId;
    const p2Fav = predId && p2.id === predId;

    document.getElementById('modal-content').innerHTML = `
        <h3>${tour.name || 'Jogo'}</h3>
        <p style="color:var(--text-dim);margin:8px 0 16px">${date(m.scheduled_at)} ${time(m.scheduled_at)} ${m.round ? '• ' + m.round : ''} ${m.surface ? '• ' + m.surface : ''}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px">
            <div style="text-align:center;flex:1">
                <div style="font-weight:700;font-size:1rem">${p1.name || 'TBD'}</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">${p1.country || ''} ${p1.ranking ? '(#' + p1.ranking + ')' : ''}</div>
                ${p1Fav && cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}%</span>` : ''}
            </div>
            <div style="font-size:1.2rem;font-weight:bold;color:var(--accent)">VS</div>
            <div style="text-align:center;flex:1">
                <div style="font-weight:700;font-size:1rem">${p2.name || 'TBD'}</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">${p2.country || ''} ${p2.ranking ? '(#' + p2.ranking + ')' : ''}</div>
                ${p2Fav && cs != null ? `<span class="confidence ${cc}">${confLabel(cs)} ${cs}/100</span>` : ''}
            </div>
        </div>
        <div id="modal-h2h" style="text-align:center;font-size:0.8rem;color:var(--text-dim);margin-bottom:12px"></div>
        ${m.score ? `<div style="text-align:center;font-size:1.3rem;font-weight:bold;color:var(--accent);margin-bottom:12px">${m.score}</div>` : ''}
        <div style="background:var(--bg);padding:12px;border-radius:8px;font-size:0.8rem">
            <p><strong>Estado:</strong> ${statusLabel(m.status)}</p>
            ${m.best_of ? `<p><strong>Formato:</strong> Melhor de ${m.best_of}</p>` : ''}
        </div>
    `;
    document.getElementById('modal').classList.add('active');

    if (p1.id && p2.id) {
        loadH2H(p1.id, p2.id);
    }
}

function showStats(s) {
    const el = document.getElementById('stats-panel');
    const accuracy = s.withPredictions > 0 ? Math.round((s.correct / s.withPredictions) * 100) : 0;
    const wrongPct = s.withPredictions > 0 ? Math.round((s.wrong / s.withPredictions) * 100) : 0;

    el.innerHTML = `
        <div class="stats-period">
            <button class="period-btn active" data-period="all">Todos</button>
            <button class="period-btn" data-period="day">Hoje</button>
            <button class="period-btn" data-period="yesterday">Ontem</button>
            <button class="period-btn" data-period="week">Semana</button>
            <button class="period-btn" data-period="month">Mês</button>
            <button class="period-btn" data-period="year">Ano</button>
        </div>
        <div class="stats-grid">
            <div class="stat"><div class="stat-value">${s.todayGames}</div><div class="stat-label">Jogos Hoje</div></div>
            <div class="stat"><div class="stat-value">${s.live}</div><div class="stat-label">Live</div></div>
            <div class="stat"><div class="stat-value">${s.completed}</div><div class="stat-label">Terminados</div></div>
            <div class="stat"><div class="stat-value">${s.total}</div><div class="stat-label">Total</div></div>
        </div>
        <div class="accuracy-box">
            <h4>Previsões</h4>
            <div class="accuracy-grid">
                <div class="accuracy-item total">
                    <span class="acc-value">${s.withPredictions}</span>
                    <span class="acc-label">Total</span>
                </div>
                <div class="accuracy-item correct">
                    <span class="acc-value">${s.correct}</span>
                    <span class="acc-label">Acertos (${accuracy}%)</span>
                </div>
                <div class="accuracy-item wrong">
                    <span class="acc-value">${s.wrong}</span>
                    <span class="acc-label">Falhas (${wrongPct}%)</span>
                </div>
            </div>
        </div>
        <div class="chart-container">
            <canvas id="accuracy-chart"></canvas>
        </div>
        <div class="trend-stats-section">
            <h4>Acertos por Tendência</h4>
            <div class="trend-panels">
                ${renderTrendPanels(s.trendStats)}
            </div>
        </div>
        <div id="trend-charts" class="trend-charts"></div>
    `;

    renderAccuracyChart(s.correct, s.wrong, accuracy, wrongPct);
    renderTrendCharts(s.trendStats);

    el.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            el.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const period = btn.dataset.period;
            try {
                const newStats = await loadStats(period);
                showStats(newStats);
            } catch (e) {
                toast('Erro: ' + e.message);
            }
        });
    });
}

function renderTrendPanels(trendStats) {
    const levels = [
        { key: 'incerto', label: 'Incerco', class: 'uncertain' },
        { key: 'perigoso', label: 'Perigoso', class: 'dangerous' },
        { key: 'tendencia', label: 'Tendência', class: 'tendency' },
        { key: 'forte', label: 'Forte', class: 'strong' }
    ];

    return levels.map(level => {
        const data = trendStats[level.key] || { total: 0, correct: 0, wrong: 0 };
        const accuracy = data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0;
        const wrongPct = data.total > 0 ? Math.round((data.wrong / data.total) * 100) : 0;

        return `
            <div class="trend-panel ${level.class}">
                <div class="trend-header">
                    <span class="trend-label">${level.label}</span>
                    <span class="trend-total">${data.total} previsões</span>
                </div>
                <div class="trend-stats">
                    <div class="trend-stat correct">
                        <span class="trend-value">${data.correct}</span>
                        <span class="trend-pct">${accuracy}%</span>
                    </div>
                    <div class="trend-stat wrong">
                        <span class="trend-value">${data.wrong}</span>
                        <span class="trend-pct">${wrongPct}%</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderTrendCharts(trendStats) {
    const levels = [
        { key: 'incerto', label: 'Incerco', color: '#f59e0b' },
        { key: 'perigoso', label: 'Perigoso', color: '#f97316' },
        { key: 'tendencia', label: 'Tendência', color: '#3b82f6' },
        { key: 'forte', label: 'Forte', color: '#22c55e' }
    ];

    const container = document.getElementById('trend-charts');
    if (!container) return;
    container.innerHTML = '';

    levels.forEach(level => {
        const data = trendStats[level.key] || { total: 0, correct: 0, wrong: 0 };
        const canvas = document.createElement('canvas');
        canvas.id = `trend-chart-${level.key}`;
        canvas.style.maxWidth = '300px';
        canvas.style.margin = '0 auto 16px';
        container.appendChild(canvas);

        new Chart(canvas, {
            type: 'bar',
            data: {
                labels: ['Acertos', 'Falhas'],
                datasets: [{
                    label: level.label,
                    data: [data.correct, data.wrong],
                    backgroundColor: ['#22c55e', '#ef4444'],
                    borderRadius: 6,
                    barThickness: 24
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true,
                        text: level.label,
                        color: '#f1f5f9',
                        font: { size: 14 }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const total = data.correct + data.wrong;
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
            }
        });
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
                barThickness: 40
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
        }
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

function toast(msg) {
    const t = document.getElementById('toast');
    if (t) {
        t.textContent = msg;
        t.classList.add('active');
        setTimeout(() => t.classList.remove('active'), 4000);
    }
}

async function switchTab(tab) {
    log('Switching to tab: ' + tab);
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.add('active');

    if (livePollInterval) {
        clearInterval(livePollInterval);
        livePollInterval = null;
    }

    if (tab === 'stats') {
        loader(true);
        try {
            const s = await loadStats('all');
            showStats(s);
        } catch (e) {
            log('ERROR loading stats: ' + e.message);
            toast('Erro: ' + e.message);
        } finally {
            loader(false);
        }
        return;
    }

    loader(true);
    try {
        if (tab === 'live') cachedData[tab] = await loadLive();
        else if (tab === 'today') cachedData[tab] = await loadToday();
        else if (tab === 'upcoming') cachedData[tab] = await loadUpcoming();
        else if (tab === 'results') cachedData[tab] = await loadResults();
        log('Loaded ' + (cachedData[tab]?.length || 0) + ' matches for ' + tab);
    } catch (e) {
        log('ERROR loading ' + tab + ': ' + e.message);
        toast('Erro: ' + e.message);
    } finally {
        loader(false);
    }

    if (tab !== 'stats') {
        renderFiltered();
    }

    if (tab === 'live') {
        livePollInterval = setInterval(async () => {
            log('Polling live matches...');
            try {
                const data = await loadLive();
                cachedData['live'] = data;
                if (currentTab === 'live') {
                    renderFiltered();
                }
            } catch (e) {
                log('Poll error: ' + e.message);
            }
        }, 30000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    log('DOM loaded, initializing...');

    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => {
            log('Tab clicked: ' + t.dataset.tab);
            switchTab(t.dataset.tab);
        });
    });

    document.querySelectorAll('.filter').forEach(f => {
        f.addEventListener('click', () => {
            log('Filter clicked: ' + f.dataset.filter);
            document.querySelectorAll('.filter').forEach(x => x.classList.remove('active'));
            f.classList.add('active');
            currentFilter = f.dataset.filter;
            renderFiltered();
        });
    });

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

    log('Initialization complete, loading live...');
    switchTab('live');
});
