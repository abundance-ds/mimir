<template>
  <div class="about-page">
    <div class="about-hero">
      <span class="about-title">Mim</span>
      <span class="about-version">v0.1.0</span>
    </div>

    <div class="about-links">
      <a href="https://shoulde.rs" target="_blank" rel="noopener">shoulde.rs</a>
    </div>

    <span class="about-copy">&copy; 2026</span>
  </div>
</template>

<style scoped>
.about-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding-top: 40px;
}

.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 16px;
}

.about-title {
  font-family: var(--font-brand);
  font-size: 24px;
  font-weight: 400;
  color: var(--color-ink);
}

.about-version {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-ink-3);
  margin-top: 4px;
}

.about-desc {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--color-ink-3);
  line-height: 1.5;
  max-width: 280px;
  margin: 0 0 20px;
}

.about-links {
  font-family: var(--font-sans);
  font-size: 11px;
  margin-bottom: 20px;
}
.about-links a {
  color: var(--color-accent);
  text-decoration: none;
}
.about-links a:hover {
  text-decoration: underline;
}

.about-sep {
  color: var(--color-ink-3);
  margin: 0 5px;
}

.about-copy {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-ink-3);
}
</style>
