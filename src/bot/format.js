function formatSignal(signal) {
  if (signal.direction === 'NO_TRADE') return null; // don't spam chat with every no-trade eval

  const arrow = signal.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const lines = [
    `${arrow}  ${signal.pair}  (${signal.exchange} · ${signal.timeframe})`,
    '',
    `Confidence: ${signal.confidence}%`,
    `Entry zone: ${signal.entryZoneLow.toFixed(5)} - ${signal.entryZoneHigh.toFixed(5)}`,
    `SL: ${signal.stopLoss.toFixed(5)}`,
    `TP: ${signal.takeProfit.toFixed(5)}`,
    `R:R: ${signal.riskReward.toFixed(2)}`,
    '',
    `Reasoning: ${signal.reasoning}`,
  ];
  return lines.join('\n');
}

function formatStats(stats, days) {
  const total = Number(stats.total_signals) || 0;
  const wins = Number(stats.wins) || 0;
  const losses = Number(stats.losses) || 0;
  const decided = wins + losses;
  const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) : 'n/a';

  return [
    `📊 Stats — last ${days} days`,
    '',
    `Signals fired: ${total}`,
    `Wins / Losses: ${wins} / ${losses}`,
    `Win rate: ${winRate}${decided > 0 ? '%' : ''}`,
    `Net pips: ${Number(stats.net_pips).toFixed(1)}`,
  ].join('\n');
}

function formatLeaderboard(rows, days) {
  if (!rows.length) return `🏆 Leaderboard — last ${days} days\n\nNo signals fired yet.`;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const decided = Number(r.wins) + Number(r.losses);
    const winRate = decided > 0 ? `${((r.wins / decided) * 100).toFixed(0)}%` : 'n/a';
    const rank = medals[i] || `${i + 1}.`;
    return `${rank} ${r.pair} — ${Number(r.net_pips).toFixed(1)} pips · ${winRate} win rate (${r.total_signals} signals)`;
  });

  return [`🏆 Leaderboard — last ${days} days`, '', ...lines].join('\n');
}

function formatDigest({ statsToday, leaderboard }) {
  const total = Number(statsToday.total_signals) || 0;
  const wins = Number(statsToday.wins) || 0;
  const losses = Number(statsToday.losses) || 0;
  const netPips = Number(statsToday.net_pips) || 0;

  const lines = [
    '🌙 Daily Digest',
    '',
    `Signals fired today: ${total}`,
    `Wins / Losses: ${wins} / ${losses}`,
    `Net pips: ${netPips.toFixed(1)}`,
  ];

  if (leaderboard.length) {
    lines.push('', 'Top pairs today:');
    leaderboard.slice(0, 3).forEach((r) => {
      lines.push(`• ${r.pair}: ${Number(r.net_pips).toFixed(1)} pips`);
    });
  }

  return lines.join('\n');
}

module.exports = {
  formatSignal, formatStats, formatLeaderboard, formatDigest,
};
