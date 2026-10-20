import { defineConfig } from 'vitest/config'

// Physics tests run the model for up to a few simulated hours; 5 min a test leaves room for a slower machine (a throttled laptop ran the threads test in 145 s, CI in 50-90 s).
export default defineConfig({ test: { testTimeout: 300_000 } })
