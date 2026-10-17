// Tests de bout en bout du parcours du salarié, sur téléphone simulé (cahier des charges § 7) :
// iPhone (moteur WebKit, celui de Safari) et Android (moteur Chromium, celui de Chrome).
// Chaque test démarre son propre serveur avec une base temporaire et des données fictives (tests/aide.js).
// Lancement : npm run test:e2e (la première fois : npx playwright install chromium webkit).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.js',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'iPhone', use: { ...devices['iPhone 13'] } },
    { name: 'Android', use: { ...devices['Pixel 7'] } },
  ],
});
