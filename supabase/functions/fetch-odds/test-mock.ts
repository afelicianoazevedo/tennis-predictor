import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const MOCK_ODDS = [
    {
        home_team: "Chan / Justin Boulais",
        away_team: "Ajeet Rai / Alexander Donski",
        bookmakers: [
            {
                markets: [
                    {
                        outcomes: [
                            { name: "Chan / Justin Boulais", price: 1.85 },
                            { name: "Ajeet Rai / Alexander Donski", price: 2.00 },
                        ],
                    },
                ],
            },
        ],
    },
];

async function testSync() {
    const { data: matches } = await supabase
        .from("matches")
        .select("id, player1_id, player2_id, scheduled_at, status")
        .eq("status", "upcoming")
        .not("player1_id", "is", null)
        .not("player2_id", "is", null)
        .limit(5);

    console.log("Upcoming matches:", matches);

    if (!matches || matches.length === 0) {
        console.log("No upcoming matches found");
        return;
    }

    const { data: players } = await supabase
        .from("players")
        .select("id, name");

    console.log("Players count:", players?.length);

    const oddsData = MOCK_ODDS;
    console.log("Mock odds data:", oddsData);

    for (const match of oddsData) {
        const homeTeam = match.home_team || match.players?.[0];
        const awayTeam = match.away_team || match.players?.[1];

        console.log(`Trying to match: ${homeTeam} vs ${awayTeam}`);

        const targetMatch = matches.find((m) => {
            const p1Name = players?.find((p) => p.id === m.player1_id)?.name || "";
            const p2Name = players?.find((p) => p.id === m.player2_id)?.name || "";
            return (
                p1Name.toLowerCase().includes(homeTeam.toLowerCase()) ||
                p2Name.toLowerCase().includes(awayTeam.toLowerCase())
            );
        });

        if (targetMatch) {
            console.log(`Matched to DB match ${targetMatch.id}`);

            const { error } = await supabase
                .from("odds")
                .upsert({
                    match_id: targetMatch.id,
                    player1_odd: 1.85,
                    player2_odd: 2.00,
                    market: "match_winner",
                    source: "mock_test",
                    captured_at: new Date().toISOString(),
                }, {
                    onConflict: "match_id,market,source",
                });

            if (error) {
                console.error("Error inserting odds:", error);
            } else {
                console.log(`Inserted odds for match ${targetMatch.id}`);
            }
        } else {
            console.log("No match found in DB");
        }
    }
}

await testSync();
console.log("Mock test completed");
