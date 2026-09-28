import { defineConfig } from 'vitest/config'

// Physics tests run the model for up to a few simulated hours.
export default defineConfig({ test: { testTimeout: 120_000 } })
