<template>
  <span class="wi" aria-label="Working">
    <span /><span /><span />
    <span /><span /><span />
    <span /><span /><span />
  </span>
</template>

<style scoped>
.wi {
  display: inline-grid;
  grid-template-columns: repeat(3, 2px);
  grid-template-rows: repeat(3, 2px);
  gap: 2px;
  flex-shrink: 0;
}

.wi > span {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--color-accent);
  will-change: opacity, transform;
}

.wi > span:nth-child(1) { animation: w1 4.2s ease-in-out infinite; }
.wi > span:nth-child(2) { animation: w2 4.2s ease-in-out infinite; }
.wi > span:nth-child(3) { animation: w3 4.2s ease-in-out infinite; }
.wi > span:nth-child(4) { animation: w4 4.2s ease-in-out infinite; }
.wi > span:nth-child(5) { animation: w5 4.2s ease-in-out infinite; }
.wi > span:nth-child(6) { animation: w6 4.2s ease-in-out infinite; }
.wi > span:nth-child(7) { animation: w7 4.2s ease-in-out infinite; }
.wi > span:nth-child(8) { animation: w8 4.2s ease-in-out infinite; }
.wi > span:nth-child(9) { animation: w9 4.2s ease-in-out infinite; }

/*
  Grid:   1 2 3        Ring (clockwise): 1 -> 2 -> 3 -> 6 -> 9 -> 8 -> 7 -> 4
          4 5 6
          7 8 9

  Phase 1 (0-24%)    Twin orbit — two dots chase clockwise, 180 deg apart
       ~  (24-30%)   Breathe — all dots inhale together
  Phase 2 (30-44%)   Center glow — center warms, edges follow
       ~  (44-52%)   Settle — energy distributes, grid exhales
  Phase 3 (52-78%)   Diagonal wave — sweep top-left to bottom-right
  Phase 4 (78-100%)  Dissolve — fade, orbit positions re-emerge
*/

@keyframes w1 {
  0%, 100% { opacity: 0.75; transform: scale(1.1); }
  8%       { opacity: 0.08; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  34%      { opacity: 0.13; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  54%      { opacity: 0.68; transform: scale(1.1); }
  62%      { opacity: 0.08; transform: scale(1); }
  90%      { opacity: 0.08; transform: scale(1); }
  95%      { opacity: 0.34; transform: scale(1.05); }
}

@keyframes w2 {
  0%, 100% { opacity: 0.08; transform: scale(1); }
  4%       { opacity: 0.2; transform: scale(1); }
  7%       { opacity: 0.75; transform: scale(1.1); }
  14%      { opacity: 0.08; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  36%      { opacity: 0.3; transform: scale(1.02); }
  44%      { opacity: 0.1; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  59%      { opacity: 0.68; transform: scale(1.1); }
  67%      { opacity: 0.08; transform: scale(1); }
}

@keyframes w3 {
  0%, 100% { opacity: 0.08; transform: scale(1); }
  10%      { opacity: 0.08; transform: scale(1); }
  13%      { opacity: 0.75; transform: scale(1.1); }
  20%      { opacity: 0.08; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  34%      { opacity: 0.13; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  64%      { opacity: 0.68; transform: scale(1.1); }
  72%      { opacity: 0.08; transform: scale(1); }
}

@keyframes w4 {
  0%, 100% { opacity: 0.08; transform: scale(1); }
  16%      { opacity: 0.08; transform: scale(1); }
  19%      { opacity: 0.75; transform: scale(1.1); }
  24%      { opacity: 0.13; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  36%      { opacity: 0.3; transform: scale(1.02); }
  44%      { opacity: 0.1; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  59%      { opacity: 0.68; transform: scale(1.1); }
  67%      { opacity: 0.08; transform: scale(1); }
}

@keyframes w5 {
  0%, 100% { opacity: 0.13; transform: scale(1); }
  12%      { opacity: 0.16; transform: scale(1.02); }
  26%      { opacity: 0.2; transform: scale(1); }
  34%      { opacity: 0.48; transform: scale(1.08); }
  38%      { opacity: 0.8; transform: scale(1.15); }
  44%      { opacity: 0.4; transform: scale(1.05); }
  48%      { opacity: 0.25; transform: scale(1); }
  64%      { opacity: 0.62; transform: scale(1.1); }
  72%      { opacity: 0.1; transform: scale(1); }
}

@keyframes w6 {
  0%, 100% { opacity: 0.08; transform: scale(1); }
  16%      { opacity: 0.08; transform: scale(1); }
  19%      { opacity: 0.75; transform: scale(1.1); }
  24%      { opacity: 0.13; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  36%      { opacity: 0.3; transform: scale(1.02); }
  44%      { opacity: 0.1; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  69%      { opacity: 0.68; transform: scale(1.1); }
  76%      { opacity: 0.08; transform: scale(1); }
}

@keyframes w7 {
  0%, 100% { opacity: 0.08; transform: scale(1); }
  10%      { opacity: 0.08; transform: scale(1); }
  13%      { opacity: 0.75; transform: scale(1.1); }
  20%      { opacity: 0.08; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  34%      { opacity: 0.13; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  64%      { opacity: 0.68; transform: scale(1.1); }
  72%      { opacity: 0.08; transform: scale(1); }
}

@keyframes w8 {
  0%, 100% { opacity: 0.08; transform: scale(1); }
  4%       { opacity: 0.2; transform: scale(1); }
  7%       { opacity: 0.75; transform: scale(1.1); }
  14%      { opacity: 0.08; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  36%      { opacity: 0.3; transform: scale(1.02); }
  44%      { opacity: 0.1; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  69%      { opacity: 0.68; transform: scale(1.1); }
  76%      { opacity: 0.08; transform: scale(1); }
}

@keyframes w9 {
  0%, 100% { opacity: 0.75; transform: scale(1.1); }
  8%       { opacity: 0.08; transform: scale(1); }
  26%      { opacity: 0.2; transform: scale(1); }
  34%      { opacity: 0.13; transform: scale(1); }
  48%      { opacity: 0.2; transform: scale(1); }
  74%      { opacity: 0.68; transform: scale(1.1); }
  82%      { opacity: 0.08; transform: scale(1); }
  90%      { opacity: 0.08; transform: scale(1); }
  95%      { opacity: 0.34; transform: scale(1.05); }
}
</style>
