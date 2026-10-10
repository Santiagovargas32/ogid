const LEVEL_COLORS={Critical:'#ff4d4f',Elevated:'#ff8c42',Monitoring:'#f4c542',Stable:'#38c172',Unknown:'#8896a6'};
export function getLevelColor(level='Stable'){return LEVEL_COLORS[level]||LEVEL_COLORS.Unknown;}
