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

module.exports = { formatSignal, formatStats };
