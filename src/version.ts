// The model's version in exports (roadmap E4): `git describe` of the build (vite.config.ts), so a file names the exact
// commit it came from; 'dev' where there is no build (tests).
declare const __MODEL_VERSION__: string | undefined
export const MODEL_VERSION = typeof __MODEL_VERSION__ === 'string' ? __MODEL_VERSION__ : 'dev'
