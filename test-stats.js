const SUPABASE_URL = 'https://ywmrxvurnxgnmpcjnisi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0';

async function loadStats() {
  const matchesRes = await fetch(`${SUPABASE_URL}/rest/v1/matches?select=id,status,scheduled_at,category,predicted_winner_id,winner_id&order=scheduled_at.desc&limit=500`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const matches = await matchesRes.json();
  
  const total = matches.length;
  const completed = matches.filter(m => m.status === 'completed').length;
  const withPredictions = matches.filter(m => m.predicted_winner_id).length;
  const verified = matches.filter(m => m.predicted_winner_id && m.winner_id);
  const correct = verified.filter(m => m.predicted_winner_id === m.winner_id).length;
  const wrong = verified.filter(m => m.predicted_winner_id !== m.winner_id).length;
  const accuracy = withPredictions > 0 ? Math.round((correct / withPredictions) * 100) : 0;
  
  console.log('Total:', total, 'Completed:', completed, 'With predictions:', withPredictions, 'Correct:', correct, 'Wrong:', wrong, 'Accuracy:', accuracy);
}

loadStats();
