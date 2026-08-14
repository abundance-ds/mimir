<template>
  <span
    class="inline-grid shrink-0 grid-cols-[repeat(3,3px)] grid-rows-[repeat(3,3px)] gap-[2px]"
    aria-label="Working"
  >
    <span
      v-for="n in 9"
      :key="n"
      class="size-[3px] rounded-full bg-accent will-change-[opacity]"
    />
  </span>
</template>

<style scoped>
span > span:nth-child(1) { animation: m1 5s ease-in-out infinite; }
span > span:nth-child(2) { animation: m2 5s ease-in-out infinite; }
span > span:nth-child(3) { animation: m3 5s ease-in-out infinite; }
span > span:nth-child(4) { animation: m4 5s ease-in-out infinite; }
span > span:nth-child(5) { animation: m5 5s ease-in-out infinite; }
span > span:nth-child(6) { animation: m6 5s ease-in-out infinite; }
span > span:nth-child(7) { animation: m7 5s ease-in-out infinite; }
span > span:nth-child(8) { animation: m8 5s ease-in-out infinite; }
span > span:nth-child(9) { animation: m9 5s ease-in-out infinite; }

@keyframes m1 {
  0%, 100% { opacity: 1; }
  4%       { opacity: .5; }
  12%      { opacity: .2; }
  28%      { opacity: .2; }
  32%      { opacity: .5; }
  36%      { opacity: 1; }
  40%      { opacity: .5; }
  48%      { opacity: .2; }
  60%      { opacity: .2; }
  64%      { opacity: .5; }
  68%      { opacity: 1; }
  72%      { opacity: .5; }
  80%      { opacity: .2; }
  92%      { opacity: .2; }
  96%      { opacity: .5; }
}

@keyframes m2 {
  0%, 100% { opacity: .2; }
  5%       { opacity: .5; }
  9%       { opacity: 1; }
  13%      { opacity: .5; }
  20%      { opacity: .2; }
  36%      { opacity: .5; }
  40%      { opacity: 1; }
  44%      { opacity: .5; }
  52%      { opacity: .2; }
  72%      { opacity: .5; }
  76%      { opacity: 1; }
  80%      { opacity: .5; }
  88%      { opacity: .2; }
}

@keyframes m3 {
  0%, 100% { opacity: .2; }
  14%      { opacity: .5; }
  18%      { opacity: 1; }
  22%      { opacity: .5; }
  30%      { opacity: .2; }
  40%      { opacity: .5; }
  44%      { opacity: 1; }
  48%      { opacity: .5; }
  56%      { opacity: .2; }
  80%      { opacity: .5; }
  84%      { opacity: 1; }
  88%      { opacity: .5; }
  94%      { opacity: .2; }
}

@keyframes m4 {
  0%, 100% { opacity: .2; }
  23%      { opacity: .5; }
  27%      { opacity: 1; }
  31%      { opacity: .5; }
  38%      { opacity: .2; }
  60%      { opacity: .5; }
  64%      { opacity: 1; }
  68%      { opacity: .5; }
  76%      { opacity: .2; }
  88%      { opacity: .5; }
  92%      { opacity: 1; }
  96%      { opacity: .5; }
}

@keyframes m5 {
  0%, 100% { opacity: .22; }
  14%      { opacity: .5; }
  18%      { opacity: .6; }
  22%      { opacity: .5; }
  30%      { opacity: .22; }
  36%      { opacity: .3; }
  40%      { opacity: .2; }
  64%      { opacity: .2; }
  68%      { opacity: .3; }
  72%      { opacity: .2; }
  92%      { opacity: .2; }
  96%      { opacity: .3; }
}

@keyframes m6 {
  0%, 100% { opacity: .2; }
  23%      { opacity: .5; }
  27%      { opacity: 1; }
  31%      { opacity: .5; }
  38%      { opacity: .2; }
  44%      { opacity: .5; }
  48%      { opacity: 1; }
  52%      { opacity: .5; }
  60%      { opacity: .2; }
  88%      { opacity: .5; }
  92%      { opacity: 1; }
  96%      { opacity: .5; }
}

@keyframes m7 {
  0%, 100% { opacity: .2; }
  14%      { opacity: .5; }
  18%      { opacity: 1; }
  22%      { opacity: .5; }
  30%      { opacity: .2; }
  56%      { opacity: .5; }
  60%      { opacity: 1; }
  64%      { opacity: .5; }
  72%      { opacity: .2; }
  80%      { opacity: .5; }
  84%      { opacity: 1; }
  88%      { opacity: .5; }
  94%      { opacity: .2; }
}

@keyframes m8 {
  0%, 100% { opacity: .2; }
  5%       { opacity: .5; }
  9%       { opacity: 1; }
  13%      { opacity: .5; }
  20%      { opacity: .2; }
  52%      { opacity: .5; }
  56%      { opacity: 1; }
  60%      { opacity: .5; }
  68%      { opacity: .2; }
  72%      { opacity: .5; }
  76%      { opacity: 1; }
  80%      { opacity: .5; }
  88%      { opacity: .2; }
}

@keyframes m9 {
  0%, 100% { opacity: 1; }
  4%       { opacity: .5; }
  12%      { opacity: .2; }
  28%      { opacity: .2; }
  32%      { opacity: .5; }
  36%      { opacity: 1; }
  40%      { opacity: .5; }
  44%      { opacity: .2; }
  48%      { opacity: .5; }
  52%      { opacity: 1; }
  56%      { opacity: .5; }
  60%      { opacity: .2; }
  64%      { opacity: .5; }
  68%      { opacity: 1; }
  72%      { opacity: .5; }
  80%      { opacity: .2; }
  92%      { opacity: .2; }
  96%      { opacity: .5; }
}
</style>
