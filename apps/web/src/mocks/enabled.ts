// Mocks stay on until the backend exists. Set VITE_MOCKS=0 to hit /api/v1.
export const MOCKS = import.meta.env.VITE_MOCKS !== '0'
